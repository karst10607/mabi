class_name PetRig2D
extends Node2D
# Production port of renderer/rig2d.js. Same 73x149 weight-baked mesh, same
# skinning shader and ambient driver as tools/godot-probe/fullrig.gd, extended
# with pose switching for the cat2d skin set (sit/walk/rest/side/belly/run).

const COLS := 72
const ROWS := 148
const ACTIVE_FRAME_MS := 30.0
const IDLE_FRAME_MS := 110.0
const WIN_W := 240.0
const WIN_H := 290.0

# protocol posture -> cat2d artwork prefix
const POSE_PREFIX := {
	"sit": "cat",
	"doze": "cat",
	"sleep": "cat",
	"rest": "cat_rest",
	"walk": "cat_walk",
	"side": "cat_side",
	"belly": "cat_belly",
	"run": "cat_run"
}

var mesh_instance: MeshInstance2D
var mat: ShaderMaterial
var meta: Dictionary
var rig: Dictionary
var has_legs := false
var gait: Dictionary = {"swing": 0.32, "amp": [0.15, 0.15, 0.12, 0.12], "lift": [9, 9, 7, 7], "phase": [0.25, 0.75, 0.0, 0.5]}
var prefix := ""
var skin := "cat2d"
var rig_scale := 1.0
var posture := "sit"
var walking := false
var eye_override := -1.0

var t := 0.0
var breath_phase := 0.0
var tail_phase := 0.0
var step_phase := 0.0
var step_amp := 0.0
var step_amp_target := 0.0
var step_speed := 4.2
var blink := 0.0
var blink_timer := 0.0
var flick_timer_l := 0.0
var flick_timer_r := 0.0
var gaze_timer := 1.5
var auto_gaze_target_x := 0.0
var auto_gaze_target_y := 0.0
var auto_gaze_x := 0.0
var auto_gaze_y := 0.0
var auto_drowsy_target := 0.0
var auto_drowsy := 0.0
var drowsy_target := 0.0
var gaze_target_x := 0.0
var gaze_target_y := 0.0
var head_angle := 0.0
var leg_angle := Vector4.ZERO
var leg_lift := Vector4.ZERO
var react_boost := 0.0

func sstep(a: float, b: float, x: float) -> float:
	var tt := clampf((x - a) / (b - a), 0.0, 1.0)
	return tt * tt * (3.0 - 2.0 * tt)

func gauss(x: float, y: float, cx: float, cy: float, sx: float, sy: float) -> float:
	return exp(-((x - cx) * (x - cx) / (2.0 * sx * sx) + (y - cy) * (y - cy) / (2.0 * sy * sy)))

func _ready() -> void:
	randomize()
	blink_timer = 2.0 + randf() * 3.0
	flick_timer_l = 4.0 + randf() * 4.0
	flick_timer_r = 6.0 + randf() * 4.0

func set_skin(new_skin: String) -> bool:
	if new_skin == "":
		return false
	skin = new_skin
	prefix = ""
	return load_pose("walk" if walking else posture)

func set_rig_scale(val: float) -> void:
	if val <= 0.0:
		return
	rig_scale = val
	if mesh_instance != null and meta != null:
		var W: float = meta.texW
		var H: float = meta.texH
		var s := minf(WIN_W / W, WIN_H / H) * rig_scale
		mesh_instance.scale = Vector2(s, s)
		mesh_instance.position = Vector2((WIN_W * rig_scale - W * s) * 0.5, (WIN_H * rig_scale - H * s) * 0.5)

func get_asset_prefix(s: String, p: String) -> String:
	var base := "cat"
	if s.begins_with("ami") or s == "shiba":
		base = "ami"
	elif s.begins_with("kk") or s == "kitsune":
		base = "kk"

	if p == "walk":
		return base + "_walk"
	elif p in ["rest", "doze", "sleep"]:
		return base + "_rest"
	elif base == "cat":
		if p == "side":
			return "cat_side"
		elif p == "belly":
			return "cat_belly"
		elif p == "run":
			return "cat_run"
	return base

func load_pose(pose: String, new_skin: String = "") -> bool:
	if new_skin != "":
		skin = new_skin
	var next_prefix: String = get_asset_prefix(skin, pose)
	if next_prefix == prefix and mesh_instance != null:
		return true
	var meta_path := "res://assets/%s_meta.json" % next_prefix
	if not ResourceLoader.exists(meta_path):
		push_warning("rig: missing meta for pose %s (%s) skin=%s" % [pose, next_prefix, skin])
		return false
	meta = JSON.parse_string(FileAccess.get_file_as_string(meta_path))
	if meta == null:
		push_warning("rig: bad meta %s" % meta_path)
		return false
	rig = meta.rig
	has_legs = rig.has("legs") and rig.legs.size() == 4
	if rig.has("gait"):
		for k in rig.gait:
			gait[k] = rig.gait[k]
	var tex := load("res://assets/%s_tex.png" % next_prefix)
	var tex_closed := load("res://assets/%s_tex_closed.png" % next_prefix)
	if tex == null:
		push_warning("rig: missing texture for %s" % next_prefix)
		return false
	if mesh_instance:
		mesh_instance.queue_free()
		mesh_instance = null
	_build_mesh(tex, tex_closed)
	prefix = next_prefix
	return true

func set_posture(next_posture: String) -> void:
	posture = next_posture
	eye_override = -1.0
	match posture:
		"doze":
			eye_override = 0.35
		"rest", "sleep":
			eye_override = 0.0
	if not walking:
		load_pose(posture)
		step_amp_target = 0.0

func set_walking(on: bool) -> void:
	walking = on
	if on:
		load_pose("walk")
		step_amp_target = 1.0
	else:
		step_amp_target = 0.0

func set_eye_override(value: float) -> void:
	eye_override = value

func play_react(emotion: String) -> void:
	react_boost = 1.0
	blink_timer = minf(blink_timer, 0.01)
	if emotion == "eating":
		flick_timer_l = -0.01
		flick_timer_r = -0.15
	else:
		flick_timer_l = -0.01
		flick_timer_r = -0.12

func frame_interval() -> float:
	return (ACTIVE_FRAME_MS if _needs_fast() else IDLE_FRAME_MS) / 1000.0

func _build_mesh(tex: Texture2D, tex_closed: Texture2D) -> void:
	var W: float = meta.texW
	var H: float = meta.texH
	var ox: float = meta.origin[0]
	var oy: float = meta.origin[1]
	var neck_tx: float = meta.neck.cx - ox
	var neck_ty: float = meta.neck.y - oy
	var eye_l: Dictionary = meta.eyes[0]
	var eye_r: Dictionary = meta.eyes[1]
	var eye_ty: float = (eye_l.cy + eye_r.cy) * 0.5 - oy
	var head_cfg: Dictionary = rig.head
	var breath_cfg: Dictionary = rig.breath
	var breath_cx: float = breath_cfg.center[0] - ox
	var breath_cy: float = breath_cfg.center[1] - oy
	var ears: Array = rig.get("ears", [])
	var paws: Array = rig.get("paws", [])
	var legs: Array = rig.get("legs", [])
	var tail: Variant = rig.get("tail", null)

	var verts := PackedVector2Array()
	var uvs := PackedVector2Array()
	var w0 := PackedColorArray()    # head, breath, tail, earL  -> COLOR
	var w1 := PackedFloat32Array()  # earR, pawL, pawR, 0       -> CUSTOM0
	var wleg := PackedFloat32Array()  # FL FR BL BR             -> CUSTOM1
	for j in range(ROWS + 1):
		for i in range(COLS + 1):
			var x := float(i) / COLS * W
			var y := float(j) / ROWS * H
			verts.append(Vector2(x, -y))
			uvs.append(Vector2(float(i) / COLS, float(j) / ROWS))

			var head := sstep(neck_ty + head_cfg.zeroBelowNeck, neck_ty - head_cfg.fullAboveNeck, y)
			if head_cfg.has("xSpan"):
				var xw := sstep(head_cfg.xSpan[1], head_cfg.xSpan[0], absf(x - neck_tx))
				var below_eyes := sstep(eye_ty - 20.0, eye_ty + 60.0, y)
				head *= 1.0 - below_eyes * (1.0 - xw)
			if head_cfg.has("xRange"):
				var xmin: float = head_cfg.xRange[0] - ox
				var xmax: float = head_cfg.xRange[1] - ox
				head *= sstep(xmin - 24.0, xmin + 12.0, x) * sstep(xmax + 24.0, xmax - 12.0, x)

			var ear_l := 0.0
			var ear_r := 0.0
			if ears.size() == 2:
				ear_l = gauss(x, y, ears[0].center[0] - ox, ears[0].center[1] - oy, ears[0].sigma[0], ears[0].sigma[1])
				ear_r = gauss(x, y, ears[1].center[0] - ox, ears[1].center[1] - oy, ears[1].sigma[0], ears[1].sigma[1])
			var paw_l := 0.0
			var paw_r := 0.0
			if paws.size() >= 1:
				paw_l = gauss(x, y, paws[0].center[0] - ox, paws[0].center[1] - oy, paws[0].sigma[0], paws[0].sigma[1])
			if paws.size() >= 2:
				paw_r = gauss(x, y, paws[1].center[0] - ox, paws[1].center[1] - oy, paws[1].sigma[0], paws[1].sigma[1])

			var tail_w := 0.0
			if tail != null:
				tail_w = sstep(tail.x[0] - ox, tail.x[1] - ox, x) * sstep(tail.y[0] - oy, tail.y[1] - oy, y)
			var breath_w := gauss(x, y, breath_cx, breath_cy, breath_cfg.sigma[0], breath_cfg.sigma[1]) * sstep(breath_cfg.fade[0] - oy, breath_cfg.fade[1] - oy, y)

			var lw := [0.0, 0.0, 0.0, 0.0]
			for k in range(legs.size()):
				var lg: Dictionary = legs[k]
				var pivot_y: float = lg.pivot[1] - oy
				lw[k] = gauss(x, y, lg.center[0] - ox, lg.center[1] - oy, lg.sigma[0], lg.sigma[1]) * sstep(pivot_y - 26.0, pivot_y + 26.0, y)

			w0.append(Color(head, breath_w, tail_w, ear_l * head))
			w1.append_array([ear_r * head, paw_l, paw_r, 0.0])
			wleg.append_array([lw[0], lw[1], lw[2], lw[3]])

	var idx := PackedInt32Array()
	for j in range(ROWS):
		for i in range(COLS):
			var a := j * (COLS + 1) + i
			var b := a + 1
			var c := a + COLS + 1
			var d := c + 1
			idx.append(a)
			idx.append(c)
			idx.append(b)
			idx.append(b)
			idx.append(c)
			idx.append(d)

	var arrays := []
	arrays.resize(Mesh.ARRAY_MAX)
	arrays[Mesh.ARRAY_VERTEX] = verts
	arrays[Mesh.ARRAY_TEX_UV] = uvs
	arrays[Mesh.ARRAY_COLOR] = w0
	arrays[Mesh.ARRAY_CUSTOM0] = w1
	arrays[Mesh.ARRAY_CUSTOM1] = wleg
	arrays[Mesh.ARRAY_INDEX] = idx
	var fmt: int = (Mesh.ARRAY_CUSTOM_RGBA_FLOAT << Mesh.ARRAY_FORMAT_CUSTOM0_SHIFT) | (Mesh.ARRAY_CUSTOM_RGBA_FLOAT << Mesh.ARRAY_FORMAT_CUSTOM1_SHIFT)
	var am := ArrayMesh.new()
	am.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arrays, [], {}, fmt)

	mat = ShaderMaterial.new()
	mat.shader = load("res://body.gdshader")
	mat.set_shader_parameter("uTex", tex)
	mat.set_shader_parameter("uTexClosed", tex_closed)
	mat.set_shader_parameter("uNeck", Vector2(neck_tx, -neck_ty))
	mat.set_shader_parameter("uBreathCx", breath_cx)
	var neck_v := Vector2(neck_tx, -neck_ty)
	mat.set_shader_parameter("uEarPivotL", _world_point(ears[0].pivot, ox, oy) if ears.size() == 2 else neck_v)
	mat.set_shader_parameter("uEarPivotR", _world_point(ears[1].pivot, ox, oy) if ears.size() == 2 else neck_v)
	mat.set_shader_parameter("uPawPivotL", _world_point(paws[0].pivot, ox, oy) if paws.size() >= 1 else neck_v)
	mat.set_shader_parameter("uPawPivotR", _world_point(paws[1].pivot, ox, oy) if paws.size() >= 2 else neck_v)
	for k in range(4):
		mat.set_shader_parameter("uLegPivot%d" % k, _world_point(legs[k].pivot, ox, oy) if legs.size() == 4 else Vector2.ZERO)
	var ers: float = float(rig.get("eyeRadiusScale", 2.0))
	mat.set_shader_parameter("uEyeLUv", Vector2((eye_l.cx - ox) / W, (eye_l.cy - oy) / H))
	mat.set_shader_parameter("uEyeRUv", Vector2((eye_r.cx - ox) / W, (eye_r.cy - oy) / H))
	mat.set_shader_parameter("uEyeLRad", Vector2(eye_l.rx * ers / W, eye_l.ry * ers / H))
	mat.set_shader_parameter("uEyeRRad", Vector2(eye_r.rx * ers / W, eye_r.ry * ers / H))
	mat.set_shader_parameter("uEyeOpen", 1.0)
	mat.set_shader_parameter("uAlpha", 1.0)

	mesh_instance = MeshInstance2D.new()
	mesh_instance.mesh = am
	mesh_instance.material = mat
	var s := minf(WIN_W / W, WIN_H / H) * rig_scale
	mesh_instance.scale = Vector2(s, s)
	mesh_instance.position = Vector2((WIN_W * rig_scale - W * s) * 0.5, (WIN_H * rig_scale - H * s) * 0.5)
	add_child(mesh_instance)

func _world_point(p: Array, ox: float, oy: float) -> Vector2:
	return Vector2(p[0] - ox, -(p[1] - oy))

func _needs_fast() -> bool:
	if step_amp > 0.004 or step_amp_target > 0.0:
		return true
	if blink > 0.004 or blink_timer < 0.25:
		return true
	if flick_timer_l < 0.0 or flick_timer_r < 0.0:
		return true
	if absf(auto_drowsy - drowsy_target) > 0.02:
		return true
	if absf(auto_gaze_x - gaze_target_x) > 0.04:
		return true
	if absf(auto_gaze_y - gaze_target_y) > 0.04:
		return true
	return false

func step(dt: float) -> void:
	t += dt
	_step(dt)
	mesh_instance.queue_redraw()
	if not walking and step_amp < 0.02 and prefix == "cat_walk":
		load_pose(posture)

func _step(dt: float) -> void:
	step_amp += (step_amp_target - step_amp) * minf(1.0, dt * 10.0)
	if step_amp > 0.01:
		step_phase = fmod(step_phase + dt * step_speed, TAU)
	var swing: float = gait.swing
	var duty := 1.0 - swing
	var cycle := step_phase / TAU
	for k in range(4):
		var amp: float = (gait.amp[k] if has_legs else 0.0) * step_amp
		var lift: float = (gait.lift[k] if has_legs else 0.0) * step_amp
		var ph := fmod(cycle + gait.phase[k], 1.0)
		if ph < 0.0:
			ph += 1.0
		var angle := 0.0
		var lift_v := 0.0
		if ph < duty:
			angle = amp * (1.0 - 2.0 * (ph / duty))
		else:
			var s := (ph - duty) / swing
			var ease := s * s * (3.0 - 2.0 * s)
			angle = amp * (-1.0 + 2.0 * ease)
			lift_v = lift * sin(PI * s)
		leg_angle[k] = angle
		leg_lift[k] = lift_v

	blink_timer -= dt
	var blink_target := 0.0
	if blink_timer <= 0.0:
		blink_target = 1.0
		if blink_timer < -0.14:
			blink_timer = 2.2 + randf() * 4.5
	blink += (blink_target - blink) * minf(1.0, dt * 26.0)

	var breath_period := 3.2
	breath_phase = fmod(breath_phase + dt / breath_period, 1.0)
	var breath := sstep(0.0, 1.0, breath_phase / 0.35) if breath_phase < 0.35 else 1.0 - sstep(0.0, 1.0, (breath_phase - 0.35) / 0.65)
	if eye_override >= 0.0:
		breath_period = 4.6

	tail_phase += dt * (1.15 + step_amp * 2.4)
	var sway := sin(t * 0.53)
	var head_bob := sin(t * 0.8 + 0.6)

	flick_timer_l -= dt
	flick_timer_r -= dt
	if flick_timer_l < -0.42:
		flick_timer_l = 3.5 + randf() * 6.5
	if flick_timer_r < -0.42:
		flick_timer_r = 4.0 + randf() * 6.5
	var el := -flick_timer_l
	var er := -flick_timer_r
	var flick_l := sin(el * 34.0) * 0.16 * (1.0 - el / 0.42) if el >= 0.0 and el <= 0.42 else 0.0
	var flick_r := sin(er * 31.0 + 1.0) * 0.16 * (1.0 - er / 0.42) if er >= 0.0 and er <= 0.42 else 0.0

	var deg := PI / 180.0
	var angle_z := sway * 0.25 * 7.0 * deg
	var angle_x := sway * 0.25
	var angle_y := head_bob * 0.5

	head_angle += (angle_z - head_angle) * minf(1.0, dt * 9.0)
	mat.set_shader_parameter("uHeadAngle", head_angle)
	mat.set_shader_parameter("uHeadShift", Vector2(angle_x * 14.0, -angle_y * 9.0 + (breath - 0.5) * 3.0))
	mat.set_shader_parameter("uHeadSquash", absf(angle_x) * 0.03)
	mat.set_shader_parameter("uBreath", breath * (1.0 + step_amp * 0.25))
	mat.set_shader_parameter("uTailSway", sin(tail_phase) * (0.55 + step_amp * 0.35))
	mat.set_shader_parameter("uEarAngleL", flick_l * 0.55)
	mat.set_shader_parameter("uEarAngleR", -flick_r * 0.55)
	mat.set_shader_parameter("uPawAngleL", sin(tail_phase * 1.25 + 0.4) * 0.075)
	mat.set_shader_parameter("uPawAngleR", -sin(tail_phase * 1.1 + 1.5) * 0.075)
	mat.set_shader_parameter("uLegAngle", leg_angle)
	mat.set_shader_parameter("uLegLift", leg_lift)

	gaze_timer -= dt
	if gaze_timer <= 0.0:
		var r := randf()
		if r < 0.44 or step_amp > 0.2:
			auto_gaze_target_x = 0.0
			auto_gaze_target_y = 0.0
			auto_drowsy_target = 0.0
			gaze_timer = 2.6 + randf() * 2.8
		elif r < 0.80:
			var dir_x := -1.0 if randf() < 0.5 else 1.0
			auto_gaze_target_x = dir_x * (0.55 + randf() * 0.35)
			auto_gaze_target_y = (randf() - 0.5) * 0.55
			auto_drowsy_target = 0.0
			gaze_timer = 2.2 + randf() * 2.6
		else:
			auto_drowsy_target = 1.0
			gaze_timer = 1.6 + randf() * 1.8
	gaze_target_x = auto_gaze_target_x
	gaze_target_y = auto_gaze_target_y
	drowsy_target = 0.0 if step_amp > 0.1 else auto_drowsy_target
	var gaze_lerp := minf(1.0, dt * 5.5)
	auto_gaze_x += (gaze_target_x - auto_gaze_x) * gaze_lerp
	auto_gaze_y += (gaze_target_y - auto_gaze_y) * gaze_lerp
	auto_drowsy += (drowsy_target - auto_drowsy) * minf(1.0, dt * 4.5)

	var eye_open := 1.0 - maxf(blink, auto_drowsy)
	if eye_override >= 0.0:
		eye_open = eye_override
	mat.set_shader_parameter("uEyeOpen", eye_open)
	var gx := clampf(auto_gaze_x + angle_x * 0.55, -0.95, 0.95)
	var gy := clampf(auto_gaze_y - angle_y * 0.45, -0.85, 0.85)
	mat.set_shader_parameter("uGaze", Vector2(gx, gy))
	react_boost = maxf(0.0, react_boost - dt * 2.5)
