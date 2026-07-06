// /mockcloud/ec2/* UI routes — port of src/routes/ec2.js.
package ec2

import (
	"encoding/json"
	"fmt"
	"math/rand/v2"
	"net/http"
	"time"

	"github.com/mockcloud/mockcloud/internal/httpapi"
	"github.com/mockcloud/mockcloud/internal/jsnum"
	"github.com/mockcloud/mockcloud/internal/protocol/respond"
	"github.com/mockcloud/mockcloud/internal/state"
)

// AMI_OS from src/routes/ec2.js — note it deliberately differs from the
// service-side AMI_MAP ('Debian 12' without the codename).
var amiOS = map[string]string{
	"ami-ubuntu-22": "Ubuntu 22.04 LTS",
	"ami-debian-12": "Debian 12",
	"ami-alpine-3":  "Alpine Linux 3.19",
	"ami-nixos-23":  "NixOS 23.11",
}

// bodyVal normalizes ParsedBody values to the any-tree model (json.Number →
// float64) so JS truthiness/String() semantics apply.
func bodyVal(body map[string]any, key string) any {
	v, ok := body[key]
	if !ok {
		return nil
	}
	if n, isNum := v.(json.Number); isNum {
		f, err := n.Float64()
		if err != nil {
			return jsnum.ToNumberFromString(n.String())
		}
		return f
	}
	return v
}

func (svc *Service) RegisterUIRoutes(add func(method, pattern string, h func(http.ResponseWriter, *httpapi.Request))) {

	add("GET", "/mockcloud/ec2/instances", func(w http.ResponseWriter, r *httpapi.Request) {
		instances := []any{}
		svc.st.With(func(s *state.State) {
			for _, k := range sortedKeys(s.EC2.Instances) {
				instances = append(instances, s.EC2.Instances[k])
			}
		})
		respond.JSON(w, 200, map[string]any{"instances": instances})
	})

	add("POST", "/mockcloud/ec2/instances", func(w http.ResponseWriter, r *httpapi.Request) {
		name := bodyVal(r.ParsedBody, "name")
		typ := bodyVal(r.ParsedBody, "type")
		ami := bodyVal(r.ParsedBody, "ami")
		assignPublicIP := bodyVal(r.ParsedBody, "assignPublicIp")
		// Match the API-boundary regex in the service handler: reject crafted
		// type/ami values so they can't smuggle markup into responses.
		// (JS `type != null` skips both absent and null.)
		if typ != nil && !safeEC2ID.MatchString(jsnum.ToString(typ)) {
			respond.ErrorJSON(w, 400, "ValidationError", "type must match [A-Za-z0-9._-]{1,64}")
			return
		}
		if ami != nil && !safeEC2ID.MatchString(jsnum.ToString(ami)) {
			respond.ErrorJSON(w, 400, "ValidationError", "ami must match [A-Za-z0-9._-]{1,64}")
			return
		}
		id := "i-" + state.RandomID(8)
		specs := typeSpec{vcpu: 1, mem: 1}
		if s, ok := instanceTypes[jsnum.ToString(typ)]; ok && typ != nil {
			specs = s
		}
		instName := any("unnamed")
		if jsnum.Truthy(name) {
			instName = name
		}
		instType := any("t3.micro")
		if jsnum.Truthy(typ) {
			instType = typ
		}
		instAmi := any("ami-ubuntu-22")
		if jsnum.Truthy(ami) {
			instAmi = ami
		}
		// os: AMI_OS[ami] || ami || 'Ubuntu 22.04 LTS'
		var osName any
		if n, ok := amiOS[jsnum.ToString(ami)]; ok && ami != nil {
			osName = n
		} else if jsnum.Truthy(ami) {
			osName = ami
		} else {
			osName = "Ubuntu 22.04 LTS"
		}
		var publicIP any
		if jsnum.Truthy(assignPublicIP) {
			publicIP = fmt.Sprintf("203.0.%d.%d", rand.IntN(200)+10, rand.IntN(254)+1)
		}
		instance := map[string]any{
			"id":        id,
			"name":      instName,
			"state":     "pending",
			"type":      instType,
			"ami":       instAmi,
			"os":        osName,
			"privateIp": fmt.Sprintf("10.0.%d.%d", rand.IntN(254)+1, rand.IntN(254)+1),
			"publicIp":  publicIP,
			"vcpu":      specs.vcpu,
			"mem":       specs.mem,
			"launched":  float64(state.NowMs()),
		}
		svc.st.With(func(s *state.State) {
			s.EC2.Instances[id] = instance
			s.AddTrail(map[string]any{"method": "POST", "path": "/ec2/instances", "status": 201, "latency": 8})
		})
		svc.scheduleInstanceState(id, "running", 500*time.Millisecond)
		respond.JSON(w, 201, instance)
	})

	add("POST", "/mockcloud/ec2/instances/:id/action", func(w http.ResponseWriter, r *httpapi.Request) {
		action := bodyVal(r.ParsedBody, "action")
		id := r.Params["id"]
		var instState any
		var found bool
		svc.st.With(func(s *state.State) {
			inst := asMap(s.EC2.Instances[id])
			if inst == nil {
				return
			}
			found = true
			switch action {
			case "stop":
				inst["state"] = "stopped"
			case "start":
				inst["state"] = "pending"
				svc.scheduleInstanceState(id, "running", 2000*time.Millisecond)
			case "reboot":
				inst["state"] = "pending"
				svc.scheduleInstanceState(id, "running", 1000*time.Millisecond)
			case "terminate":
				inst["state"] = "terminated"
				// delete on a missing key is a safe no-op after reset
				svc.scheduleInstanceDelete(id, 5000*time.Millisecond)
			}
			instState = inst["state"]
			s.AddTrail(map[string]any{"method": "POST", "path": "/ec2/" + id + "/" + jsnum.ToString(action), "status": 200, "latency": 3})
		})
		if !found {
			respond.ErrorJSON(w, 404, "NotFound", "Instance not found")
			return
		}
		respond.JSON(w, 200, map[string]any{"id": id, "action": action, "state": instState})
	})
}
