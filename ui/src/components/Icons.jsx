// Icons — stroke-based, 16px default. Exact match to design file.
import React from 'react';

const I = (d, o = {}) => ({ size = 16, style, className, ...rest } = {}) =>
  React.createElement('svg', {
    width: size, height: size, viewBox: '0 0 24 24',
    fill: 'none', stroke: 'currentColor',
    strokeWidth: o.sw || 1.75,
    strokeLinecap: 'round', strokeLinejoin: 'round',
    'aria-hidden': 'true', style, className, ...rest,
  }, d);

const e = React.createElement;

export const IconHome     = I(e('path', { d: 'M4 11 12 4l8 7v8a1 1 0 0 1-1 1h-4v-6h-6v6H5a1 1 0 0 1-1-1z' }));
export const IconEC2      = I(e('g', null, e('rect',{x:4,y:4,width:16,height:16,rx:2}), e('rect',{x:8,y:8,width:8,height:8,rx:1}), e('path',{d:'M10 4V2M14 4V2M10 22v-2M14 22v-2M4 10H2M4 14H2M22 10h-2M22 14h-2'})));
export const IconS3       = I(e('g', null, e('ellipse',{cx:12,cy:6,rx:8,ry:3}), e('path',{d:'M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6'}), e('path',{d:'M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6'})));
export const IconLambda   = I(e('path', { d: 'M4 4h4l6 16h4M10 14H6', strokeLinejoin: 'miter' }));
export const IconDB       = I(e('g', null, e('ellipse',{cx:12,cy:5,rx:8,ry:3}), e('path',{d:'M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6'})));
export const IconSNS      = I(e('g', null, e('path',{d:'M6 8a4 4 0 0 1 8 0v4l2 2H4l2-2z'}), e('path',{d:'M9 16a3 3 0 0 0 6 0'})));
export const IconSQS      = I(e('g', null, e('rect',{x:3,y:6,width:12,height:4,rx:1}), e('rect',{x:3,y:14,width:12,height:4,rx:1}), e('path',{d:'M17 8h4M17 16h4M19 10v4'})));
export const IconSecrets  = I(e('g', null, e('rect',{x:4,y:10,width:16,height:11,rx:2}), e('path',{d:'M8 10V7a4 4 0 0 1 8 0v3'}), e('circle',{cx:12,cy:15,r:1.2,fill:'currentColor'})));
export const IconIAM      = I(e('g', null, e('circle',{cx:12,cy:8,r:3.5}), e('path',{d:'M5 20a7 7 0 0 1 14 0'})));
export const IconWatch    = I(e('g', null, e('circle',{cx:12,cy:12,r:8}), e('path',{d:'M12 8v4l2.5 2.5'})));
export const IconTrail    = I(e('g', null, e('path',{d:'M4 7h16M4 12h10M4 17h16'}), e('circle',{cx:18,cy:12,r:2,fill:'currentColor',stroke:'none'})));
export const IconBilling  = I(e('g', null, e('rect',{x:3,y:6,width:18,height:12,rx:2}), e('path',{d:'M3 10h18M7 15h3'})));

export const IconSearch   = I(e('g', null, e('circle',{cx:11,cy:11,r:7}), e('path',{d:'m20 20-3.5-3.5'})));
export const IconChevDown = I(e('path', { d: 'm6 9 6 6 6-6' }));
export const IconChevRight= I(e('path', { d: 'm9 6 6 6-6 6' }));
export const IconRefresh  = I(e('g', null, e('path',{d:'M3 12a9 9 0 0 1 15.5-6.3L21 8'}), e('path',{d:'M21 3v5h-5'}), e('path',{d:'M21 12a9 9 0 0 1-15.5 6.3L3 16'}), e('path',{d:'M3 21v-5h5'})));
export const IconPlus     = I(e('path', { d: 'M12 5v14M5 12h14' }));
export const IconSun      = I(e('g', null, e('circle',{cx:12,cy:12,r:4}), e('path',{d:'M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4'})));
export const IconMoon     = I(e('path', { d: 'M20 14.5A8 8 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z' }));
export const IconSettings = I(e('g', null, e('circle',{cx:12,cy:12,r:3}), e('path',{d:'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09c0 .66.39 1.26 1 1.51a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.25.61.85 1 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z'})));
export const IconPlay     = I(e('path', { d: 'M6 4v16l14-8z' }));
export const IconStop     = I(e('rect', { x: 5, y: 5, width: 14, height: 14, rx: 1 }));
export const IconMore     = I(e('g', null, e('circle',{cx:12,cy:6,r:1.3,fill:'currentColor',stroke:'none'}), e('circle',{cx:12,cy:12,r:1.3,fill:'currentColor',stroke:'none'}), e('circle',{cx:12,cy:18,r:1.3,fill:'currentColor',stroke:'none'})));
export const IconX        = I(e('path', { d: 'M18 6 6 18M6 6l12 12' }));
export const IconCopy     = I(e('g', null, e('rect',{x:9,y:9,width:12,height:12,rx:2}), e('path',{d:'M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1'})));
export const IconCloud    = I(e('path', { d: 'M7 17a5 5 0 0 1 0-10 6 6 0 0 1 11.5 2.5A4.5 4.5 0 0 1 17 17z' }));
export const IconCheck    = I(e('path', { d: 'm5 12 5 5L20 7' }));
export const IconFolder   = I(e('path', { d: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' }));
export const IconFile     = I(e('g', null, e('path',{d:'M6 3h8l4 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z'}), e('path',{d:'M14 3v4h4'})));
export const IconUpload   = I(e('g', null, e('path',{d:'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4'}), e('path',{d:'M17 8 12 3 7 8'}), e('path',{d:'M12 3v13'})));
export const IconDownload = I(e('g', null, e('path',{d:'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4'}), e('path',{d:'M7 10l5 5 5-5'}), e('path',{d:'M12 15V3'})));
export const IconFilter   = I(e('path', { d: 'M3 5h18l-7 9v6l-4-2v-4z' }));
export const IconSparkles = I(e('g', null, e('path',{d:'M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2 2M16 16l2 2M18 6l-2 2M8 16l-2 2'})));
export const IconTerminal = I(e('g', null, e('path',{d:'m5 9 4 3-4 3'}), e('path',{d:'M11 15h8'}), e('rect',{x:2,y:4,width:20,height:16,rx:2})));
