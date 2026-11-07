shader_type canvas_item;
// Direct port of AuraPet renderer/rig2d.js VERT + FRAG (THREE.ShaderMaterial).
// The ArrayMesh stores vertices in the same rig space as the THREE geometry:
// (x, -y) with y = texture row, so every formula below is line-for-line the
// original. Only the final y-flip back to Godot's y-down canvas space differs.
// Weight packing: COLOR = (head, breath, tail, earL),
// CUSTOM0 = (earR, pawL, pawR, 0), CUSTOM1 = leg weights vec4.

uniform sampler2D uTex : filter_linear_mipmap, repeat_disable;
uniform sampler2D uTexClosed : filter_linear_mipmap, repeat_disable;

uniform vec2 uNeck;
uniform float uBreathCx;
uniform vec2 uHeadShift;
uniform float uHeadAngle;
uniform float uHeadSquash;
uniform float uBreath;
uniform float uTailSway;
uniform vec2 uEarPivotL;
uniform vec2 uEarPivotR;
uniform float uEarAngleL;
uniform float uEarAngleR;
uniform vec2 uPawPivotL;
uniform vec2 uPawPivotR;
uniform float uPawAngleL;
uniform float uPawAngleR;
uniform vec2 uLegPivot0;
uniform vec2 uLegPivot1;
uniform vec2 uLegPivot2;
uniform vec2 uLegPivot3;
uniform vec4 uLegAngle;
uniform vec4 uLegLift;

uniform vec2 uEyeLUv;
uniform vec2 uEyeRUv;
uniform vec2 uEyeLRad;
uniform vec2 uEyeRRad;
uniform float uEyeOpen;
uniform vec2 uGaze;
uniform float uAlpha;

vec2 rotateAbout(vec2 p, vec2 pivot, float a) {
	vec2 d = p - pivot;
	float c = cos(a), s = sin(a);
	return pivot + vec2(c * d.x - s * d.y, s * d.x + c * d.y);
}

void vertex() {
	vec2 p = VERTEX;
	float aHead = COLOR.x;
	float aBreath = COLOR.y;
	float aTail = COLOR.z;
	float aEarL = COLOR.w;
	float aEarR = CUSTOM0.x;
	float aPawL = CUSTOM0.y;
	float aPawR = CUSTOM0.z;
	vec4 aLeg = CUSTOM1;

	// ears swing about their base in texture space; head transform carries them
	p = mix(p, rotateAbout(p, uEarPivotL, uEarAngleL), aEarL);
	p = mix(p, rotateAbout(p, uEarPivotR, uEarAngleR), aEarR);

	// head: rigid about neck, weight-blended so the neck stretches, not tears
	vec2 rel = p - uNeck;
	float a = uHeadAngle * aHead;
	float c = cos(a), s = sin(a);
	rel = vec2(c * rel.x - s * rel.y, s * rel.x + c * rel.y);
	rel.x *= 1.0 - uHeadSquash * aHead;
	p = uNeck + rel + uHeadShift * aHead;

	// front paws (idle knead; walk skin has no paw weights)
	p = mix(p, rotateAbout(p, uPawPivotL, uPawAngleL), aPawL);
	p = mix(p, rotateAbout(p, uPawPivotR, uPawAngleR), aPawR);

	// four-legged walk: swing about shoulder/hip, lift only during swing phase
	p = mix(p, rotateAbout(p, uLegPivot0, uLegAngle.x), aLeg.x);
	p.y += aLeg.x * uLegLift.x;
	p = mix(p, rotateAbout(p, uLegPivot1, uLegAngle.y), aLeg.y);
	p.y += aLeg.y * uLegLift.y;
	p = mix(p, rotateAbout(p, uLegPivot2, uLegAngle.z), aLeg.z);
	p.y += aLeg.z * uLegLift.z;
	p = mix(p, rotateAbout(p, uLegPivot3, uLegAngle.w), aLeg.w);
	p.y += aLeg.w * uLegLift.w;

	// ribcage breath: lift + widen, faded out by the elbows
	float chest = aBreath * uBreath;
	p.y += chest * 9.0;
	p.x += (p.x - uBreathCx) * chest * 0.055;

	// tail sway, strongest at the tip
	p.x += uTailSway * aTail * 34.0;
	p.y += abs(uTailSway) * aTail * 10.0;

	// rig space is y-up (THREE); Godot canvas is y-down
	VERTEX = vec2(p.x, -p.y);
}

vec2 gazeUv(vec2 uv, vec2 ctr, vec2 r) {
	vec2 d = (uv - ctr) / r;
	float dist = length(d);
	// warp confined inside dist < 0.45 so the eyeliner rim never folds
	float m = 1.0 - smoothstep(0.10, 0.45, dist);
	vec2 g = clamp(uGaze, vec2(-1.0), vec2(1.0));
	return uv - g * r * 0.165 * m;
}

void fragment() {
	vec2 uv = UV;
	vec2 openUv = gazeUv(gazeUv(uv, uEyeLUv, uEyeLRad), uEyeRUv, uEyeRRad);
	vec4 openEye = texture(uTex, clamp(openUv, vec2(0.0), vec2(1.0)));
	vec4 shutEye = texture(uTexClosed, uv);
	vec4 c = mix(openEye, shutEye, 1.0 - uEyeOpen);
	COLOR = vec4(c.rgb, c.a * uAlpha);
	if (COLOR.a < 0.004) {
		discard;
	}
}