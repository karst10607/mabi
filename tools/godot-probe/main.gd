extends Node2D
# Mirrors AuraPet's idle damage rate: content updates at --rate Hz (default 14,
# the measured Electron idle draw rate). Transparent borderless always-on-top
# window, same 240x290 as the pet window. Measures whether bypassing Chromium's
# per-damage transparent-window composite removes the Linux idle CPU floor.

var sprite: Sprite2D
var acc := 0.0
var rate := 14.0
var t := 0.0
const BASE_SCALE := 0.189  # 618x1270 tex -> ~117x240 px

func _ready() -> void:
	get_tree().root.transparent_bg = true
	for a in OS.get_cmdline_user_args():
		if a.begins_with("--rate="):
			rate = float(a.substr(7))
		if a == "--lowproc":
			# Redraw only when content changes; sleep between updates instead of
			# presenting at vsync forever.
			OS.low_processor_usage_mode = true
			OS.low_processor_usage_mode_sleep_usec = 70000
	sprite = Sprite2D.new()
	sprite.texture = load("res://cat_tex.png")
	sprite.scale = Vector2(BASE_SCALE, BASE_SCALE)
	sprite.position = Vector2(120, 145)
	add_child(sprite)

func _process(delta: float) -> void:
	acc += delta
	if acc < 1.0 / rate:
		return
	t += acc
	acc = 0.0
	# Same ambient life as the pet idle: slow bob + breath squash.
	sprite.position.y = 145.0 + sin(t * 1.8) * 3.0
	var b := 1.0 + sin(t * 1.9) * 0.01
	sprite.scale = Vector2(BASE_SCALE * b, BASE_SCALE / b)