// Package ec2 — port of src/services/ec2.js: the query/XML protocol handler
// for the simulated-instance state machine (pending→running via timers),
// security groups (ingress/egress rules), key pairs, tags, and the static
// Describe* surfaces (images/AZs/regions/VPCs/subnets/IGWs/route tables/
// instance types). EC2 state is an any-tree (map[string]any values) exactly
// like Node's plain objects — see internal/state.EC2State.
package ec2

import (
	"fmt"
	"math"
	"math/rand/v2"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/mockcloud/mockcloud/internal/httpapi"
	"github.com/mockcloud/mockcloud/internal/jsnum"
	"github.com/mockcloud/mockcloud/internal/protocol/respond"
	"github.com/mockcloud/mockcloud/internal/state"
	"github.com/mockcloud/mockcloud/internal/store"
)

// Strict allowlist for instance type / image id values, so crafted
// identifiers can't smuggle markup into the XML/JSON responses they're
// echoed into (src/services/ec2.js SAFE_EC2_ID).
var safeEC2ID = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)

type typeSpec struct{ vcpu, mem float64 }

// INSTANCE_TYPES / AMI_MAP — with explicit orders because Node relied on
// object-literal insertion order for Object.keys/entries.
var instanceTypes = map[string]typeSpec{
	"t3.nano":    {vcpu: 1, mem: 0.5},
	"t3.micro":   {vcpu: 2, mem: 1},
	"t3.small":   {vcpu: 2, mem: 2},
	"t3.medium":  {vcpu: 2, mem: 4},
	"m6i.large":  {vcpu: 2, mem: 8},
	"c6i.xlarge": {vcpu: 4, mem: 8},
}

var instanceTypeOrder = []string{"t3.nano", "t3.micro", "t3.small", "t3.medium", "m6i.large", "c6i.xlarge"}

var amiMap = map[string]string{
	"ami-ubuntu-22": "Ubuntu 22.04 LTS",
	"ami-debian-12": "Debian 12 (Bookworm)",
	"ami-alpine-3":  "Alpine Linux 3.19",
	"ami-nixos-23":  "NixOS 23.11",
}

var amiOrder = []string{"ami-ubuntu-22", "ami-debian-12", "ami-alpine-3", "ami-nixos-23"}

type Service struct {
	st *store.Store
}

func New(st *store.Store) *Service { return &Service{st: st} }

// ── shared helpers ──────────────────────────────────────────────────────────

// getList collects `${prefix}.1..N` until the first absent/empty value
// (Node's `if (!v) break` treats both the same).
func getList(params url.Values, prefix string) []string {
	var out []string
	for i := 1; ; i++ {
		v := params.Get(prefix + "." + strconv.Itoa(i))
		if v == "" {
			break
		}
		out = append(out, v)
	}
	return out
}

// filterIDs — the shared InstanceId.N-or-Filter.N.Name=instance-id pattern.
func filterIDs(params url.Values, filterName string, maxFilters int) []string {
	ids := getList(params, "InstanceId")
	if len(ids) > 0 {
		return ids
	}
	for f := 1; f <= maxFilters; f++ {
		if params.Get(fmt.Sprintf("Filter.%d.Name", f)) == filterName {
			return getList(params, fmt.Sprintf("Filter.%d.Value", f))
		}
	}
	return nil
}

func contains(list []string, v string) bool {
	for _, s := range list {
		if s == v {
			return true
		}
	}
	return false
}

// tmpl — `${v}` template-literal interpolation over any-tree values.
func tmpl(v any) string { return jsnum.ToString(v) }

// esc — escapeXml(v) (Node coerced with String() first).
func esc(v any) string { return respond.EscapeXML(jsnum.ToString(v)) }

func asMap(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}

func asSlice(v any) []any {
	s, _ := v.([]any)
	return s
}

func ec2Wrap(tag, inner string) string {
	return `<?xml version="1.0"?><` + tag + ` xmlns="http://ec2.amazonaws.com/doc/2016-11-15/">` + inner + `<requestId>` + state.RandomID(36) + `</requestId></` + tag + `>`
}

func ec2Error(w http.ResponseWriter, code, message string) {
	respond.XML(w, 400, ec2Wrap("ErrorResponse",
		"<Errors><Error><Code>"+code+"</Code><Message>"+message+"</Message></Error></Errors>"))
}

func stateCode(s any) int {
	switch s {
	case "running":
		return 16
	case "stopped":
		return 80
	case "pending":
		return 0
	case "terminated":
		return 48
	case "stopping":
		return 64
	}
	return 0
}

// msToISO — new Date(ms).toISOString() over an any-tree number.
func msToISO(v any) string {
	f := jsnum.ToNumber(v)
	if math.IsNaN(f) {
		f = 0
	}
	return state.ISO(int64(f))
}

// sortedKeys — deterministic iteration over any-maps (Node used insertion
// order; nothing observable depends on it, so sorted is fine and stable).
func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// scheduleInstanceState re-checks the store when the timer fires so the flip
// no-ops if the instance was deleted/reset meanwhile — the Go equivalent of
// Node's unref'd setTimeout + `if (store.ec2.instances[id])` guard. Never
// holds the lock across the wait.
func (svc *Service) scheduleInstanceState(id, newState string, d time.Duration) {
	time.AfterFunc(d, func() {
		svc.st.With(func(s *state.State) {
			if inst := asMap(s.EC2.Instances[id]); inst != nil {
				inst["state"] = newState
			}
		})
	})
}

func (svc *Service) scheduleInstanceDelete(id string, d time.Duration) {
	time.AfterFunc(d, func() {
		svc.st.With(func(s *state.State) { delete(s.EC2.Instances, id) })
	})
}

// ── handler ─────────────────────────────────────────────────────────────────

func (svc *Service) Handler(w http.ResponseWriter, r *httpapi.Request) {
	params, _ := url.ParseQuery(string(r.RawBody))
	action := r.Query.Get("Action")
	if action == "" {
		action = params.Get("Action")
	}

	switch action {
	case "DescribeInstances":
		svc.describeInstances(w, params)
	case "DescribeInstanceStatus":
		svc.describeInstanceStatus(w, params)
	case "DescribeInstanceAttribute":
		svc.describeInstanceAttribute(w, params)
	case "RunInstances":
		svc.runInstances(w, params)
	case "TerminateInstances":
		svc.terminateInstances(w, params)
	case "StopInstances":
		svc.stopInstances(w, params)
	case "StartInstances":
		svc.startInstances(w, params)
	case "DescribeImages":
		var items strings.Builder
		for _, id := range amiOrder {
			items.WriteString("<item><imageId>" + id + "</imageId><name>" + esc(amiMap[id]) + "</name><state>available</state></item>")
		}
		respond.XML(w, 200, ec2Wrap("DescribeImagesResponse", "<imagesSet>"+items.String()+"</imagesSet>"))
	case "DescribeAvailabilityZones":
		respond.XML(w, 200, ec2Wrap("DescribeAvailabilityZonesResponse",
			`<availabilityZoneInfo><item><zoneName>us-east-1a</zoneName><state>available</state><regionName>us-east-1</regionName></item><item><zoneName>us-east-1b</zoneName><state>available</state><regionName>us-east-1</regionName></item></availabilityZoneInfo>`))
	case "DescribeRegions":
		respond.XML(w, 200, ec2Wrap("DescribeRegionsResponse",
			`<regionInfo><item><regionName>us-east-1</regionName><regionEndpoint>localhost:4566</regionEndpoint></item></regionInfo>`))
	case "CreateSecurityGroup":
		svc.createSecurityGroup(w, params)
	case "DescribeSecurityGroups":
		svc.describeSecurityGroups(w, params)
	case "CreateTags":
		svc.createTags(w, params)
	case "DescribeSecurityGroupRules":
		svc.describeSecurityGroupRules(w, params)
	case "AuthorizeSecurityGroupIngress":
		svc.authorizeIngress(w, params)
	case "AuthorizeSecurityGroupEgress":
		svc.authorizeEgress(w, params)
	case "RevokeSecurityGroupIngress":
		svc.revoke(w, params, "ingressRules", "RevokeSecurityGroupIngressResponse")
	case "RevokeSecurityGroupEgress":
		svc.revoke(w, params, "egressRules", "RevokeSecurityGroupEgressResponse")
	case "DeleteSecurityGroup":
		svc.deleteSecurityGroup(w, params)
	case "CreateKeyPair":
		svc.createKeyPair(w, params)
	case "DescribeKeyPairs":
		svc.describeKeyPairs(w)
	case "DeleteKeyPair":
		svc.st.With(func(s *state.State) { delete(s.EC2.KeyPairs, params.Get("KeyName")) })
		respond.XML(w, 200, ec2Wrap("DeleteKeyPairResponse", "<return>true</return>"))
	case "ImportKeyPair":
		svc.importKeyPair(w, params)
	case "DescribeVpcs":
		respond.XML(w, 200, ec2Wrap("DescribeVpcsResponse",
			`<vpcSet><item><vpcId>vpc-mockcloud1</vpcId><cidrBlock>10.0.0.0/16</cidrBlock><state>available</state><isDefault>true</isDefault></item></vpcSet>`))
	case "DescribeSubnets":
		respond.XML(w, 200, ec2Wrap("DescribeSubnetsResponse",
			`<subnetSet><item><subnetId>subnet-mock0001</subnetId><vpcId>vpc-mockcloud1</vpcId><cidrBlock>10.0.1.0/24</cidrBlock><availabilityZone>us-east-1a</availabilityZone><state>available</state></item></subnetSet>`))
	case "DescribeInternetGateways":
		respond.XML(w, 200, ec2Wrap("DescribeInternetGatewaysResponse",
			`<internetGatewaySet><item><internetGatewayId>igw-mock0001</internetGatewayId><attachmentSet><item><vpcId>vpc-mockcloud1</vpcId><state>available</state></item></attachmentSet></item></internetGatewaySet>`))
	case "DescribeRouteTables":
		respond.XML(w, 200, ec2Wrap("DescribeRouteTablesResponse",
			`<routeTableSet><item><routeTableId>rtb-mock0001</routeTableId><vpcId>vpc-mockcloud1</vpcId></item></routeTableSet>`))
	case "DescribeInstanceTypes":
		svc.describeInstanceTypes(w, params)
	default:
		// Don't fake a 200 success for actions we don't implement — that
		// silently breaks IaC (e.g. Terraform thinks a resource changed when
		// it didn't).
		if action == "" {
			action = "(none)"
		}
		respond.ErrorXML(w, 400, "InvalidAction", "Unsupported EC2 action: "+action)
	}
}

// ── instances ───────────────────────────────────────────────────────────────

func (svc *Service) describeInstances(w http.ResponseWriter, params url.Values) {
	ids := filterIDs(params, "instance-id", 10)
	var reservations strings.Builder
	svc.st.With(func(s *state.State) {
		for _, key := range sortedKeys(s.EC2.Instances) {
			i := asMap(s.EC2.Instances[key])
			if i == nil || (len(ids) > 0 && !contains(ids, tmpl(i["id"]))) {
				continue
			}
			tags := asMap(i["tags"])
			if i["tags"] == nil {
				tags = map[string]any{"Name": i["name"]}
			}
			var tagItems strings.Builder
			for _, k := range sortedKeys(tags) {
				tagItems.WriteString("<item><key>" + esc(k) + "</key><value>" + esc(tags[k]) + "</value></item>")
			}
			publicBits := ""
			assocBits := ""
			if jsnum.Truthy(i["publicIp"]) {
				publicBits = "<ipAddress>" + tmpl(i["publicIp"]) + "</ipAddress><dnsName>" + tmpl(i["id"]) + ".compute.amazonaws.com</dnsName>"
				assocBits = "<association><publicIp>" + tmpl(i["publicIp"]) + "</publicIp></association>"
			}
			reservations.WriteString(fmt.Sprintf(`<item>
          <reservationId>r-%s</reservationId>
          <ownerId>123456789012</ownerId>
          <groupSet/>
          <instancesSet><item>
            <instanceId>%s</instanceId>
            <instanceType>%s</instanceType>
            <imageId>%s</imageId>
            <instanceState><code>%d</code><name>%s</name></instanceState>
            <privateDnsName>%s.internal</privateDnsName>
            <privateIpAddress>%s</privateIpAddress>
            %s
            <launchTime>%s</launchTime>
            <placement><availabilityZone>us-east-1a</availabilityZone><tenancy>default</tenancy></placement>
            <architecture>x86_64</architecture>
            <virtualizationType>hvm</virtualizationType>
            <hypervisor>nitro</hypervisor>
            <vpcId>vpc-mockcloud1</vpcId>
            <subnetId>subnet-mock0001</subnetId>
            <sourceDestCheck>true</sourceDestCheck>
            <groupSet/>
            <tagSet>%s</tagSet>
            <networkInterfaceSet><item>
              <networkInterfaceId>eni-%s</networkInterfaceId>
              <subnetId>subnet-mock0001</subnetId>
              <vpcId>vpc-mockcloud1</vpcId>
              <privateIpAddress>%s</privateIpAddress>
              %s
              <attachment><deviceIndex>0</deviceIndex><status>attached</status></attachment>
            </item></networkInterfaceSet>
          </item></instancesSet>
        </item>`,
				state.RandomID(8), tmpl(i["id"]), tmpl(i["type"]), tmpl(i["ami"]),
				stateCode(i["state"]), tmpl(i["state"]), tmpl(i["id"]), tmpl(i["privateIp"]),
				publicBits, msToISO(i["launched"]), tagItems.String(),
				state.RandomID(8), tmpl(i["privateIp"]), assocBits))
		}
	})
	respond.XML(w, 200, ec2Wrap("DescribeInstancesResponse",
		"<reservationSet>"+reservations.String()+"</reservationSet>"))
}

func (svc *Service) describeInstanceStatus(w http.ResponseWriter, params url.Values) {
	// Terraform v5 waits for system+instance status checks to be "ok" before
	// marking creation done.
	ids := filterIDs(params, "instance-id", 10)
	var items strings.Builder
	svc.st.With(func(s *state.State) {
		for _, key := range sortedKeys(s.EC2.Instances) {
			i := asMap(s.EC2.Instances[key])
			if i == nil || i["state"] != "running" {
				continue
			}
			if len(ids) > 0 && !contains(ids, tmpl(i["id"])) {
				continue
			}
			items.WriteString(fmt.Sprintf(`<item>
        <instanceId>%s</instanceId>
        <availabilityZone>us-east-1a</availabilityZone>
        <instanceState><code>16</code><name>running</name></instanceState>
        <systemStatus>
          <status>ok</status>
          <details><item><name>reachability</name><status>passed</status></item></details>
        </systemStatus>
        <instanceStatus>
          <status>ok</status>
          <details><item><name>reachability</name><status>passed</status></item></details>
        </instanceStatus>
      </item>`, tmpl(i["id"])))
		}
	})
	respond.XML(w, 200, ec2Wrap("DescribeInstanceStatusResponse", "<instanceStatusSet>"+items.String()+"</instanceStatusSet>"))
}

func (svc *Service) describeInstanceAttribute(w http.ResponseWriter, params url.Values) {
	instID := params.Get("InstanceId")
	attr := params.Get("Attribute")
	var inst map[string]any
	svc.st.With(func(s *state.State) { inst = asMap(s.EC2.Instances[instID]) })
	if inst == nil {
		respond.XML(w, 400, ec2Wrap("ErrorResponse",
			"<Errors><Error><Code>InvalidInstanceID.NotFound</Code><Message>Instance not found</Message></Error></Errors>"))
		return
	}
	var valueXML string
	switch attr {
	case "userData":
		valueXML = "<userData/>"
	case "disableApiTermination":
		valueXML = "<disableApiTermination><value>false</value></disableApiTermination>"
	case "disableApiStop":
		valueXML = "<disableApiStop><value>false</value></disableApiStop>"
	case "instanceType":
		valueXML = "<instanceType><value>" + tmpl(inst["type"]) + "</value></instanceType>"
	case "sourceDestCheck":
		valueXML = "<sourceDestCheck><value>true</value></sourceDestCheck>"
	case "rootDeviceName":
		valueXML = "<rootDeviceName><value>/dev/xvda</value></rootDeviceName>"
	default:
		valueXML = "<" + attr + "/>"
	}
	respond.XML(w, 200, ec2Wrap("DescribeInstanceAttributeResponse",
		"<instanceId>"+instID+"</instanceId>"+valueXML))
}

func (svc *Service) runInstances(w http.ResponseWriter, params url.Values) {
	typ := params.Get("InstanceType")
	if typ == "" {
		typ = "t3.micro"
	}
	imageID := params.Get("ImageId")
	if imageID == "" {
		imageID = "ami-ubuntu-22"
	}
	if !safeEC2ID.MatchString(typ) || !safeEC2ID.MatchString(imageID) {
		ec2Error(w, "InvalidParameterValue", "InstanceType and ImageId must match [A-Za-z0-9._-]{1,64}")
		return
	}
	maxCount := params.Get("MaxCount")
	if maxCount == "" {
		maxCount = "1"
	}
	count := jsnum.ParseIntPrefix(maxCount) // parseInt: NaN → zero loop iterations
	nameTag := params.Get("TagSpecification.1.Tag.1.Value")
	if nameTag == "" {
		nameTag = params.Get("TagSpecification.1.Tag.2.Value")
	}
	if nameTag == "" {
		nameTag = "unnamed"
	}
	pubIP := params.Get("AssociatePublicIpAddress") != "false"
	specs, ok := instanceTypes[typ]
	if !ok {
		specs = typeSpec{vcpu: 1, mem: 1}
	}
	osName := imageID
	if n, ok := amiMap[imageID]; ok {
		osName = n
	}

	var created []map[string]any
	svc.st.With(func(s *state.State) {
		for idx := 0; float64(idx) < count; idx++ {
			id := "i-" + state.RandomID(8)
			name := nameTag
			if count > 1 {
				name = fmt.Sprintf("%s-%d", nameTag, idx+1)
			}
			var publicIP any
			if pubIP {
				publicIP = fmt.Sprintf("203.0.%d.%d", rand.IntN(200)+10, rand.IntN(254)+1)
			}
			instance := map[string]any{
				"id": id, "name": name,
				"state": "pending",
				"type":  typ, "ami": imageID, "os": osName,
				"privateIp": fmt.Sprintf("10.0.%d.%d", rand.IntN(254)+1, rand.IntN(254)+1),
				"publicIp":  publicIP,
				"vcpu":      specs.vcpu, "mem": specs.mem,
				"launched": float64(state.NowMs()),
			}
			s.EC2.Instances[id] = instance
			created = append(created, instance)
		}
	})

	var items strings.Builder
	for _, i := range created {
		svc.scheduleInstanceState(tmpl(i["id"]), "running", 2*time.Second)
		items.WriteString(fmt.Sprintf(`<item>
        <instanceId>%s</instanceId>
        <instanceType>%s</instanceType>
        <imageId>%s</imageId>
        <instanceState><code>0</code><name>pending</name></instanceState>
        <privateIpAddress>%s</privateIpAddress>
      </item>`, tmpl(i["id"]), tmpl(i["type"]), tmpl(i["ami"]), tmpl(i["privateIp"])))
	}
	respond.XML(w, 200, ec2Wrap("RunInstancesResponse", "<instancesSet>"+items.String()+"</instancesSet>"))
}

func (svc *Service) terminateInstances(w http.ResponseWriter, params url.Values) {
	ids := getList(params, "InstanceId")
	var results strings.Builder
	svc.st.With(func(s *state.State) {
		for _, id := range ids {
			inst := asMap(s.EC2.Instances[id])
			prev := "terminated"
			if inst != nil {
				prev = tmpl(inst["state"])
				inst["state"] = "shutting-down"
				// Transition to terminated after 1s so Terraform's
				// DescribeInstances waiter sees the correct terminal state
				// instead of NotFound; clean up from the store after 5 minutes
				// — long past any TF waiter poll cycle.
				svc.scheduleInstanceState(id, "terminated", 1*time.Second)
				svc.scheduleInstanceDelete(id, 300*time.Second)
			}
			results.WriteString("<item><instanceId>" + id + "</instanceId><previousState><name>" + prev + "</name></previousState><currentState><name>shutting-down</name></currentState></item>")
		}
	})
	respond.XML(w, 200, ec2Wrap("TerminateInstancesResponse", "<instancesSet>"+results.String()+"</instancesSet>"))
}

func (svc *Service) stopInstances(w http.ResponseWriter, params url.Values) {
	ids := getList(params, "InstanceId")
	var items strings.Builder
	svc.st.With(func(s *state.State) {
		for _, id := range ids {
			if inst := asMap(s.EC2.Instances[id]); inst != nil {
				inst["state"] = "stopped"
			}
			items.WriteString("<item><instanceId>" + id + "</instanceId><currentState><name>stopped</name></currentState></item>")
		}
	})
	respond.XML(w, 200, ec2Wrap("StopInstancesResponse", "<instancesSet>"+items.String()+"</instancesSet>"))
}

func (svc *Service) startInstances(w http.ResponseWriter, params url.Values) {
	ids := getList(params, "InstanceId")
	var items strings.Builder
	svc.st.With(func(s *state.State) {
		for _, id := range ids {
			if inst := asMap(s.EC2.Instances[id]); inst != nil {
				inst["state"] = "pending"
				svc.scheduleInstanceState(id, "running", 2*time.Second)
			}
			items.WriteString("<item><instanceId>" + id + "</instanceId><currentState><name>pending</name></currentState></item>")
		}
	})
	respond.XML(w, 200, ec2Wrap("StartInstancesResponse", "<instancesSet>"+items.String()+"</instancesSet>"))
}

// ── security groups ─────────────────────────────────────────────────────────

func (svc *Service) createSecurityGroup(w http.ResponseWriter, params url.Values) {
	sgID := "sg-" + state.RandomID(8)
	svc.st.With(func(s *state.State) {
		vpcID := params.Get("VpcId")
		if vpcID == "" {
			vpcID = "vpc-mockcloud1"
		}
		s.EC2.SecurityGroups[sgID] = map[string]any{
			"id":           sgID,
			"name":         formVal(params, "GroupName"),
			"description":  formVal(params, "GroupDescription"),
			"vpcId":        vpcID,
			"tags":         map[string]any{},
			"ingressRules": []any{},
			"egressRules":  []any{},
		}
	})
	respond.XML(w, 200, ec2Wrap("CreateSecurityGroupResponse", "<groupId>"+sgID+"</groupId>"))
}

// formVal — params.get(k): present → string, absent → nil (Node's null).
func formVal(params url.Values, key string) any {
	if params.Has(key) {
		return params.Get(key)
	}
	return nil
}

// ruleXML renders one ingress/egress rule (values interpolated unescaped,
// exactly like Node's template).
func ruleXML(r map[string]any) string {
	return "<item><ipProtocol>" + tmpl(r["protocol"]) + "</ipProtocol><fromPort>" + tmpl(r["fromPort"]) +
		"</fromPort><toPort>" + tmpl(r["toPort"]) + "</toPort><ipRanges><item><cidrIp>" + tmpl(r["cidr"]) +
		"</cidrIp></item></ipRanges></item>"
}

func (svc *Service) describeSecurityGroups(w http.ResponseWriter, params url.Values) {
	// Support direct GroupId.N params and both filter-by-group-id and
	// filter-by-vpc-id shapes.
	ids := getList(params, "GroupId")
	if len(ids) == 0 {
		for f := 1; f <= 5; f++ {
			name := params.Get(fmt.Sprintf("Filter.%d.Name", f))
			if name == "group-id" || name == "GroupId" {
				ids = getList(params, fmt.Sprintf("Filter.%d.Value", f))
				break
			}
		}
	}
	var sgs strings.Builder
	svc.st.With(func(s *state.State) {
		for _, key := range sortedKeys(s.EC2.SecurityGroups) {
			sg := asMap(s.EC2.SecurityGroups[key])
			if sg == nil || (len(ids) > 0 && !contains(ids, tmpl(sg["id"]))) {
				continue
			}
			var ingress, egress, tagSet strings.Builder
			for _, r := range asSlice(sg["ingressRules"]) {
				ingress.WriteString(ruleXML(asMap(r)))
			}
			for _, r := range asSlice(sg["egressRules"]) {
				egress.WriteString(ruleXML(asMap(r)))
			}
			tags := asMap(sg["tags"])
			for _, k := range sortedKeys(tags) {
				tagSet.WriteString("<item><key>" + esc(k) + "</key><value>" + esc(tags[k]) + "</value></item>")
			}
			desc := ""
			if jsnum.Truthy(sg["description"]) {
				desc = jsnum.ToString(sg["description"])
			}
			vpcID := "vpc-mockcloud1"
			if jsnum.Truthy(sg["vpcId"]) {
				vpcID = tmpl(sg["vpcId"])
			}
			sgs.WriteString(fmt.Sprintf(`<item>
          <ownerId>123456789012</ownerId>
          <groupId>%s</groupId>
          <groupName>%s</groupName>
          <groupDescription>%s</groupDescription>
          <vpcId>%s</vpcId>
          <ipPermissions>%s</ipPermissions>
          <ipPermissionsEgress>%s</ipPermissionsEgress>
          <tagSet>%s</tagSet>
        </item>`, tmpl(sg["id"]), esc(sg["name"]), respond.EscapeXML(desc), vpcID,
				ingress.String(), egress.String(), tagSet.String()))
		}
	})
	respond.XML(w, 200, ec2Wrap("DescribeSecurityGroupsResponse", "<securityGroupInfo>"+sgs.String()+"</securityGroupInfo>"))
}

func (svc *Service) createTags(w http.ResponseWriter, params url.Values) {
	// Tag any resource type by ID.
	resourceIDs := getList(params, "ResourceId")
	tags := map[string]any{}
	for i := 1; ; i++ {
		k := params.Get(fmt.Sprintf("Tag.%d.Key", i))
		if k == "" {
			break
		}
		tags[k] = params.Get(fmt.Sprintf("Tag.%d.Value", i)) // `v || ''` — Get returns "" for absent
	}
	svc.st.With(func(s *state.State) {
		for _, id := range resourceIDs {
			if sg := asMap(s.EC2.SecurityGroups[id]); sg != nil {
				sgTags := asMap(sg["tags"])
				if sgTags == nil {
					sgTags = map[string]any{}
					sg["tags"] = sgTags
				}
				for k, v := range tags {
					sgTags[k] = v
				}
			}
			if inst := asMap(s.EC2.Instances[id]); inst != nil {
				merged := map[string]any{}
				for k, v := range asMap(inst["tags"]) {
					merged[k] = v
				}
				for k, v := range tags {
					merged[k] = v
				}
				inst["tags"] = merged
			}
			for _, kpKey := range sortedKeys(s.EC2.KeyPairs) {
				kp := asMap(s.EC2.KeyPairs[kpKey])
				if kp != nil && (kp["keyId"] == any(id) || kp["name"] == any(id)) {
					merged := map[string]any{}
					for k, v := range asMap(kp["tags"]) {
						merged[k] = v
					}
					for k, v := range tags {
						merged[k] = v
					}
					kp["tags"] = merged
					break // Array.prototype.find — first match only
				}
			}
		}
	})
	respond.XML(w, 200, ec2Wrap("CreateTagsResponse", "<return>true</return>"))
}

func (svc *Service) describeSecurityGroupRules(w http.ResponseWriter, params url.Values) {
	// Return stored ingress+egress rules with synthetic rule IDs.
	sgID := params.Get("Filter.1.Value.1")
	for f := 1; f <= 5; f++ {
		if params.Get(fmt.Sprintf("Filter.%d.Name", f)) == "group-id" {
			sgID = params.Get(fmt.Sprintf("Filter.%d.Value.1", f))
			break
		}
	}
	var sg map[string]any
	var rules strings.Builder
	svc.st.With(func(s *state.State) {
		if sgID != "" {
			sg = asMap(s.EC2.SecurityGroups[sgID])
		}
		if sg == nil {
			return
		}
		gid := tmpl(sg["id"])
		for i, r := range asSlice(sg["ingressRules"]) {
			rm := asMap(r)
			rules.WriteString(fmt.Sprintf("<item><securityGroupRuleId>sgr-in-%s-%d</securityGroupRuleId><groupId>%s</groupId><isEgress>false</isEgress><ipProtocol>%s</ipProtocol><fromPort>%s</fromPort><toPort>%s</toPort><cidrIpv4>%s</cidrIpv4></item>",
				gid, i, gid, tmpl(rm["protocol"]), tmpl(rm["fromPort"]), tmpl(rm["toPort"]), tmpl(rm["cidr"])))
		}
		for i, r := range asSlice(sg["egressRules"]) {
			rm := asMap(r)
			rules.WriteString(fmt.Sprintf("<item><securityGroupRuleId>sgr-eg-%s-%d</securityGroupRuleId><groupId>%s</groupId><isEgress>true</isEgress><ipProtocol>%s</ipProtocol><fromPort>%s</fromPort><toPort>%s</toPort><cidrIpv4>%s</cidrIpv4></item>",
				gid, i, gid, tmpl(rm["protocol"]), tmpl(rm["fromPort"]), tmpl(rm["toPort"]), tmpl(rm["cidr"])))
		}
	})
	if sg == nil {
		respond.XML(w, 200, ec2Wrap("DescribeSecurityGroupRulesResponse", "<securityGroupRuleSet/>"))
		return
	}
	respond.XML(w, 200, ec2Wrap("DescribeSecurityGroupRulesResponse", "<securityGroupRuleSet>"+rules.String()+"</securityGroupRuleSet>"))
}

func (svc *Service) authorizeIngress(w http.ResponseWriter, params url.Values) {
	sgID := params.Get("GroupId")
	var found bool
	svc.st.With(func(s *state.State) {
		sg := asMap(s.EC2.SecurityGroups[sgID])
		if sg == nil {
			return
		}
		found = true
		rules := asSlice(sg["ingressRules"])
		// Collect all permission entries (Terraform sends IpPermissions.N.*).
		i := 1
		for params.Get(fmt.Sprintf("IpPermissions.%d.IpProtocol", i)) != "" {
			rules = append(rules, map[string]any{
				"protocol": params.Get(fmt.Sprintf("IpPermissions.%d.IpProtocol", i)),
				"fromPort": orDefaultNum(params, fmt.Sprintf("IpPermissions.%d.FromPort", i), 0),
				"toPort":   orDefaultNum(params, fmt.Sprintf("IpPermissions.%d.ToPort", i), 65535),
				"cidr":     orDefaultStr(params, fmt.Sprintf("IpPermissions.%d.IpRanges.1.CidrIp", i), "0.0.0.0/0"),
			})
			i++
		}
		// Also handle flat params (older SDK format).
		if i == 1 && params.Get("IpProtocol") != "" {
			rules = append(rules, map[string]any{
				"protocol": params.Get("IpProtocol"),
				"fromPort": orDefaultNum(params, "FromPort", 0),
				"toPort":   orDefaultNum(params, "ToPort", 65535),
				"cidr":     orDefaultStr(params, "CidrIp", "0.0.0.0/0"),
			})
		}
		sg["ingressRules"] = rules
	})
	if !found {
		ec2Error(w, "InvalidGroup.NotFound", "Security group not found")
		return
	}
	respond.XML(w, 200, ec2Wrap("AuthorizeSecurityGroupIngressResponse", "<return>true</return>"))
}

func (svc *Service) authorizeEgress(w http.ResponseWriter, params url.Values) {
	sgID := params.Get("GroupId")
	var found bool
	svc.st.With(func(s *state.State) {
		sg := asMap(s.EC2.SecurityGroups[sgID])
		if sg == nil {
			return
		}
		found = true
		rules := asSlice(sg["egressRules"])
		for i := 1; params.Get(fmt.Sprintf("IpPermissions.%d.IpProtocol", i)) != ""; i++ {
			proto := params.Get(fmt.Sprintf("IpPermissions.%d.IpProtocol", i))
			// rawFrom != null ? rawFrom : 0 — present (even empty) keeps the
			// string; absent falls back.
			var fromPort any = float64(0)
			if params.Has(fmt.Sprintf("IpPermissions.%d.FromPort", i)) {
				fromPort = params.Get(fmt.Sprintf("IpPermissions.%d.FromPort", i))
			}
			var toPort any
			if params.Has(fmt.Sprintf("IpPermissions.%d.ToPort", i)) {
				toPort = params.Get(fmt.Sprintf("IpPermissions.%d.ToPort", i))
			} else if proto == "-1" {
				toPort = float64(0)
			} else {
				toPort = float64(65535)
			}
			rules = append(rules, map[string]any{
				"protocol": proto,
				"fromPort": fromPort,
				"toPort":   toPort,
				"cidr":     orDefaultStr(params, fmt.Sprintf("IpPermissions.%d.IpRanges.1.CidrIp", i), "0.0.0.0/0"),
			})
		}
		sg["egressRules"] = rules
	})
	if !found {
		ec2Error(w, "InvalidGroup.NotFound", "Security group not found")
		return
	}
	respond.XML(w, 200, ec2Wrap("AuthorizeSecurityGroupEgressResponse", "<return>true</return>"))
}

// orDefaultNum — Node's `params.get(k) || <number>`: absent/empty → the
// number, else the raw string.
func orDefaultNum(params url.Values, key string, def float64) any {
	if v := params.Get(key); v != "" {
		return v
	}
	return def
}

func orDefaultStr(params url.Values, key, def string) string {
	if v := params.Get(key); v != "" {
		return v
	}
	return def
}

func (svc *Service) revoke(w http.ResponseWriter, params url.Values, field, respTag string) {
	sgID := params.Get("GroupId")
	svc.st.With(func(s *state.State) {
		sg := asMap(s.EC2.SecurityGroups[sgID])
		if sg != nil {
			sg[field] = filterRevoked(asSlice(sg[field]), params)
		}
	})
	respond.XML(w, 200, ec2Wrap(respTag, "<return>true</return>"))
}

// filterRevoked parses the IpPermissions.N.* form-encoded shape and removes
// only matching rules. Matches by (protocol, fromPort, toPort, cidr) — the
// same tuple AWS uses to identify a rule.
func filterRevoked(existing []any, params url.Values) []any {
	var toRemove []map[string]any
	for i := 1; params.Get(fmt.Sprintf("IpPermissions.%d.IpProtocol", i)) != ""; i++ {
		// `?? 0` / `?? 65535` — nullish, so present-but-empty keeps "".
		var fromPort any = float64(0)
		if params.Has(fmt.Sprintf("IpPermissions.%d.FromPort", i)) {
			fromPort = params.Get(fmt.Sprintf("IpPermissions.%d.FromPort", i))
		}
		var toPort any = float64(65535)
		if params.Has(fmt.Sprintf("IpPermissions.%d.ToPort", i)) {
			toPort = params.Get(fmt.Sprintf("IpPermissions.%d.ToPort", i))
		}
		toRemove = append(toRemove, map[string]any{
			"protocol": params.Get(fmt.Sprintf("IpPermissions.%d.IpProtocol", i)),
			"fromPort": fromPort,
			"toPort":   toPort,
			"cidr":     orDefaultStr(params, fmt.Sprintf("IpPermissions.%d.IpRanges.1.CidrIp", i), "0.0.0.0/0"),
		})
	}
	// Flat (older SDK) form.
	if len(toRemove) == 0 && params.Get("IpProtocol") != "" {
		var fromPort any = float64(0)
		if params.Has("FromPort") {
			fromPort = params.Get("FromPort")
		}
		var toPort any = float64(65535)
		if params.Has("ToPort") {
			toPort = params.Get("ToPort")
		}
		toRemove = append(toRemove, map[string]any{
			"protocol": params.Get("IpProtocol"),
			"fromPort": fromPort,
			"toPort":   toPort,
			"cidr":     orDefaultStr(params, "CidrIp", "0.0.0.0/0"),
		})
	}
	// No rules specified → nothing to remove (AWS would actually error here,
	// but we just no-op rather than silently wiping the whole rule set).
	if len(toRemove) == 0 {
		return existing
	}
	kept := []any{}
	for _, raw := range existing {
		r := asMap(raw)
		removed := false
		for _, t := range toRemove {
			if jsnum.ToString(t["protocol"]) == jsnum.ToString(r["protocol"]) &&
				jsnum.ToString(t["fromPort"]) == jsnum.ToString(r["fromPort"]) &&
				jsnum.ToString(t["toPort"]) == jsnum.ToString(r["toPort"]) &&
				jsnum.ToString(t["cidr"]) == jsnum.ToString(r["cidr"]) {
				removed = true
				break
			}
		}
		if !removed {
			kept = append(kept, raw)
		}
	}
	return kept
}

func (svc *Service) deleteSecurityGroup(w http.ResponseWriter, params url.Values) {
	sgID := params.Get("GroupId")
	if sgID == "" {
		sgID = params.Get("GroupName")
	}
	svc.st.With(func(s *state.State) {
		if sgID == "" {
			return
		}
		// find by id or name
		found := asMap(s.EC2.SecurityGroups[sgID])
		if found == nil {
			for _, k := range sortedKeys(s.EC2.SecurityGroups) {
				sg := asMap(s.EC2.SecurityGroups[k])
				if sg != nil && sg["name"] == any(sgID) {
					found = sg
					break
				}
			}
		}
		if found != nil {
			delete(s.EC2.SecurityGroups, tmpl(found["id"]))
		}
	})
	respond.XML(w, 200, ec2Wrap("DeleteSecurityGroupResponse", "<return>true</return>"))
}

// ── key pairs ───────────────────────────────────────────────────────────────

func (svc *Service) createKeyPair(w http.ResponseWriter, params url.Values) {
	name := params.Get("KeyName")
	material := "-----BEGIN RSA PRIVATE KEY-----\n" + state.RandomID(256) + "\n-----END RSA PRIVATE KEY-----"
	svc.st.With(func(s *state.State) {
		s.EC2.KeyPairs[name] = map[string]any{
			"name": name, "keyId": "key-" + state.RandomID(8),
			"fingerprint": state.RandomID(20), "material": material,
		}
	})
	// Node emitted a FRESH randomId(20) as the response fingerprint (not the
	// stored one) — a quirk we keep.
	respond.XML(w, 200, ec2Wrap("CreateKeyPairResponse",
		"<keyName>"+respond.EscapeXML(name)+"</keyName><keyFingerprint>"+state.RandomID(20)+"</keyFingerprint><keyMaterial>"+material+"</keyMaterial>"))
}

func (svc *Service) describeKeyPairs(w http.ResponseWriter) {
	var kps strings.Builder
	svc.st.With(func(s *state.State) {
		for _, k := range sortedKeys(s.EC2.KeyPairs) {
			kp := asMap(s.EC2.KeyPairs[k])
			if kp == nil {
				continue
			}
			kps.WriteString("<item><keyName>" + esc(kp["name"]) + "</keyName><keyFingerprint>" + tmpl(kp["fingerprint"]) + "</keyFingerprint></item>")
		}
	})
	respond.XML(w, 200, ec2Wrap("DescribeKeyPairsResponse", "<keySet>"+kps.String()+"</keySet>"))
}

func (svc *Service) importKeyPair(w http.ResponseWriter, params url.Values) {
	name := params.Get("KeyName")
	fingerprint := state.RandomID(20)
	svc.st.With(func(s *state.State) {
		s.EC2.KeyPairs[name] = map[string]any{
			"name": name, "keyId": "key-" + state.RandomID(8),
			"fingerprint": fingerprint, "material": nil,
		}
	})
	respond.XML(w, 200, ec2Wrap("ImportKeyPairResponse",
		"<keyName>"+respond.EscapeXML(name)+"</keyName><keyFingerprint>"+fingerprint+"</keyFingerprint>"))
}

// ── static Describe* ────────────────────────────────────────────────────────

func (svc *Service) describeInstanceTypes(w http.ResponseWriter, params url.Values) {
	// Collect requested types from InstanceType.N params or the instance-type
	// filter.
	var requested []string
	for i := 1; ; i++ {
		v := params.Get(fmt.Sprintf("InstanceType.%d", i))
		if v == "" {
			break
		}
		requested = append(requested, v)
	}
	for f := 1; f <= 10; f++ {
		if params.Get(fmt.Sprintf("Filter.%d.Name", f)) == "instance-type" {
			for v := 1; ; v++ {
				val := params.Get(fmt.Sprintf("Filter.%d.Value.%d", f, v))
				if val == "" {
					break
				}
				requested = append(requested, val)
			}
		}
	}
	var types []string
	if len(requested) > 0 {
		for _, t := range requested {
			if _, ok := instanceTypes[t]; ok {
				types = append(types, t)
			}
		}
	} else {
		types = instanceTypeOrder
	}
	var items strings.Builder
	for _, t := range types {
		s := instanceTypes[t]
		items.WriteString(fmt.Sprintf(`<item>
          <instanceType>%s</instanceType>
          <currentGeneration>true</currentGeneration>
          <vCpuInfo><defaultVCpus>%s</defaultVCpus><defaultCores>%s</defaultCores><defaultThreadsPerCore>2</defaultThreadsPerCore></vCpuInfo>
          <memoryInfo><sizeInMiB>%s</sizeInMiB></memoryInfo>
          <processorInfo><supportedArchitectures><item>x86_64</item></supportedArchitectures><sustainedClockSpeedInGhz>3.1</sustainedClockSpeedInGhz></processorInfo>
          <networkInfo><networkPerformance>Up to 5 Gigabit</networkPerformance><maximumNetworkInterfaces>3</maximumNetworkInterfaces></networkInfo>
          <hypervisor>nitro</hypervisor>
          <instanceStorageSupported>false</instanceStorageSupported>
          <ebsInfo><ebsOptimizedSupport>default</ebsOptimizedSupport><encryptionSupport>supported</encryptionSupport></ebsInfo>
        </item>`,
			t, jsnum.Format(s.vcpu), jsnum.Format(math.Ceil(s.vcpu/2)), jsnum.Format(s.mem*1024)))
	}
	respond.XML(w, 200, ec2Wrap("DescribeInstanceTypesResponse", "<instanceTypeSet>"+items.String()+"</instanceTypeSet>"))
}
