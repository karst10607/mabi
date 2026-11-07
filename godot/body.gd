extends Node2D
# AuraPet Godot body v0 (Epic #7 / issue #11).
#
# Owns the transparent window, the rig, tray, click-through, roam motion and the
# WS client for docs/ws-protocol.md v1. The Node daemon stays the brain (state,
# AI, MCP); this scene only renders and executes window/movement commands.
#
# Usage:
#   godot --path godot -- --config=/path/app-settings.json [--port=47821]
#          [--lowproc] [--rate=N] [--walk] [--shot=/tmp/x.png] [--shot-after=3]
#          [--no-tray] [--selftest=tray]

const PROTOCOL_VERSION := 1
const DEFAULT_PORT := 47821
const DEFAULT_UI_PORT := 47830
const PET_SIZE := Vector2i(240, 290)
const CHAT_SIZE := Vector2i(460, 680)
const ROAM := {"minDistance": 110, "speed": 78.0, "tick": 0.033}
const PING_INTERVAL := 15.0
const PONG_TIMEOUT := 45.0
const HELLO_TIMEOUT := 5.0
const ACTIVE_FRAME := 0.030
const IDLE_FRAME := 0.110

var rig: PetRig2D
var bubble_panel: PanelContainer
var bubble_label: RichTextLabel
var bubble_timer := 0.0
var font: SystemFont

var config_path := ""
var token := ""
var port := DEFAULT_PORT
var ui_port := DEFAULT_UI_PORT
var lowproc := false
var fixed_rate := 0.0
var force_walk := false
var shot_path := ""
var shot_after := 3.0
var shot_done := false
var use_tray := true
var selftest := ""
var elapsed := 0.0
var anim_acc := 0.0
var frame_interval := IDLE_FRAME
var draws := 0
var stat_t := 0.0

var ws: WebSocketPeer = null
var bridge_enabled := true
var conn_state := 0  # 0 disconnected, 1 connecting, 2 handshaking, 3 ready
var next_connect_at := 0
var reconnect_delay := 1.0
var hello_id := 1
var handshake_started := 0.0
var last_pong := 0.0
var ping_timer := 0.0
var hello_sent := false

var mode := "pet"
var posture := "sit"
var skin := "cat2d"
var nickname := ""
var roam_enabled := false
var roam_forced := false
var always_on_top := true
var click_through := false
var is_visible := true
var pet_pos := Vector2i.ZERO
var paused := false

var roaming := false
var roam_tick_acc := 0.0
var roam_start := 0.0
var roam_start_x := 0
var roam_start_y := 0
var roam_dx := 0
var roam_dur := 0
var left_down := false
var left_dragging := false
var press_global := Vector2i.ZERO
var press_window := Vector2i.ZERO

var tray_menu = null
var tray_rid := RID()
var tray_id := -1
var tray_pid := -1
var idx_always := -1
var idx_roam := -1
var idx_visible := -1

func _ready() -> void:
	get_tree().root.transparent_bg = true
	_parse_args()
	if shot_path != "":
		use_tray = false
	rig = PetRig2D.new()
	rig.name = "Rig"
	add_child(rig)
	if not rig.load_pose("cat"):
		push_error("body: could not load sit skin")
		get_tree().quit(1)
		return
	_build_bubble()
	if use_tray:
		_setup_tray()
	_place_initial_window()
	_apply_always_on_top(true)
	if lowproc:
		OS.low_processor_usage_mode = true
		OS.low_processor_usage_mode_sleep_usec = 70000
	if force_walk:
		roam_forced = true
		rig.set_walking(true)
	if selftest != "":
		bridge_enabled = false
		use_tray = false
		_run_selftest(selftest)
	else:
		_connect_bridge()
	print("body ready: mode=%s lowproc=%s tray=%s config=%s scale=%d" % [mode, lowproc, tray_id >= 0 or tray_pid > 0, config_path, DisplayServer.screen_get_scale()])

func _parse_args() -> void:
	for a in OS.get_cmdline_user_args():
		if a.begins_with("--config="):
			config_path = a.substr(9)
		elif a.begins_with("--token="):
			token = a.substr(8)
		elif a.begins_with("--port="):
			port = int(a.substr(7))
		elif a.begins_with("--ui-port="):
			ui_port = int(a.substr(10))
		elif a == "--lowproc":
			lowproc = true
		elif a.begins_with("--rate="):
			fixed_rate = float(a.substr(7))
		elif a == "--walk":
			force_walk = true
		elif a.begins_with("--shot="):
			shot_path = a.substr(7)
		elif a.begins_with("--shot-after="):
			shot_after = float(a.substr(13))
		elif a == "--no-tray":
			use_tray = false
		elif a.begins_with("--selftest="):
			selftest = a.substr(11)
	if config_path == "":
		config_path = _default_config_path()
	if token == "":
		token = _read_config_token()

func _default_config_path() -> String:
	# Same file Electron v1.5.2 used (app.getPath('userData')).
	match OS.get_name():
		"Windows":
			var win_base := OS.get_environment("APPDATA")
			if win_base == "":
				var profile := OS.get_environment("USERPROFILE")
				if profile == "":
					profile = OS.get_environment("HOMEDRIVE") + OS.get_environment("HOMEPATH")
				if profile != "":
					win_base = profile + "/AppData/Roaming"
			if win_base != "":
				return win_base + "/aurapet-desktop/app-settings.json"
		"macOS":
			var home := OS.get_environment("HOME")
			if home != "":
				return home + "/Library/Application Support/aurapet-desktop/app-settings.json"
	var base := OS.get_environment("XDG_CONFIG_HOME")
	if base == "":
		base = OS.get_environment("HOME") + "/.config"
	return base + "/aurapet-desktop/app-settings.json"

func _read_config_token() -> String:
	if not FileAccess.file_exists(config_path):
		push_error("body: config not found: %s" % config_path)
		return ""
	var data = JSON.parse_string(FileAccess.get_file_as_string(config_path))
	if data is Dictionary and typeof(data.get("bridgeToken")) == TYPE_STRING:
		return data.bridgeToken
	push_error("body: config has no bridgeToken: %s" % config_path)
	return ""

func _place_initial_window() -> void:
	var pos = Vector2i.ZERO
	var scale := maxi(1, DisplayServer.screen_get_scale(DisplayServer.window_get_current_screen()))
	if FileAccess.file_exists(config_path):
		var data = JSON.parse_string(FileAccess.get_file_as_string(config_path))
		if data is Dictionary and data.get("petPosition") is Dictionary:
			var p = data.petPosition
			if typeof(p.get("x")) == TYPE_FLOAT or typeof(p.get("x")) == TYPE_INT:
				pos = Vector2i(int(p.x) * scale, int(p.y) * scale)
	if pos == Vector2i.ZERO:
		var wa := DisplayServer.screen_get_usable_rect(DisplayServer.window_get_current_screen())
		pos = wa.position + wa.size - PET_SIZE - Vector2i(40, 30)
	DisplayServer.window_set_size(PET_SIZE)
	DisplayServer.window_set_position(pos)
	pet_pos = pos
	print("body: initial pos=%s size=%s screen=%s rect=%s" % [pos, PET_SIZE,
		DisplayServer.window_get_current_screen(),
		DisplayServer.screen_get_usable_rect(DisplayServer.window_get_current_screen())])

func _build_bubble() -> void:
	var layer := CanvasLayer.new()
	layer.layer = 10
	add_child(layer)
	font = SystemFont.new()
	font.font_names = PackedStringArray([
		"Noto Sans CJK TC", "Noto Sans CJK SC", "WenQuanYi Zen Hei",
		"Noto Color Emoji", "DejaVu Sans"
	])
	font.allow_system_fallback = true
	bubble_panel = PanelContainer.new()
	bubble_panel.mouse_filter = Control.MOUSE_FILTER_IGNORE
	var style := StyleBoxFlat.new()
	style.bg_color = Color(1, 1, 1, 0.94)
	style.corner_radius_top_left = 12
	style.corner_radius_top_right = 12
	style.corner_radius_bottom_left = 12
	style.corner_radius_bottom_right = 12
	style.border_width_bottom = 1
	style.border_color = Color(0.78, 0.78, 0.84, 0.9)
	style.content_margin_left = 10
	style.content_margin_right = 10
	style.content_margin_top = 6
	style.content_margin_bottom = 6
	bubble_panel.add_theme_stylebox_override("panel", style)
	bubble_label = RichTextLabel.new()
	bubble_label.bbcode_enabled = true
	bubble_label.fit_content = true
	bubble_label.scroll_active = false
	bubble_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	bubble_label.custom_minimum_size = Vector2(204, 0)
	bubble_label.mouse_filter = Control.MOUSE_FILTER_IGNORE
	bubble_label.add_theme_font_override("normal_font", font)
	bubble_label.add_theme_font_size_override("normal_font_size", 13)
	bubble_label.add_theme_color_override("default_color", Color(0.12, 0.12, 0.16))
	bubble_panel.add_child(bubble_label)
	bubble_panel.visible = false
	layer.add_child(bubble_panel)

func _setup_tray() -> void:
	if not DisplayServer.has_feature(DisplayServer.FEATURE_STATUS_INDICATOR):
		# Godot 4.7 only implements status indicators on Windows/macOS.
		if OS.get_name() == "Linux":
			_spawn_tray_helper()
		else:
			print("tray: status indicator unsupported on this display server")
		return
	tray_menu = NativeMenu
	tray_rid = tray_menu.create_menu()
	var i_title: int = tray_menu.add_item(tray_rid, "AuraPet 桌面寵物", Callable())
	tray_menu.set_item_disabled(tray_rid, i_title, true)
	tray_menu.add_separator(tray_rid)
	tray_menu.add_item(tray_rid, "切換寵物/對話形態", Callable(self, "_tray_toggle_mode"))
	idx_visible = tray_menu.add_item(tray_rid, "顯示 / 隱藏", Callable(self, "_tray_toggle_visible"))
	idx_always = tray_menu.add_check_item(tray_rid, "置頂顯示", Callable(self, "_tray_toggle_top"))
	idx_roam = tray_menu.add_check_item(tray_rid, "到處走 (螢幕邊緣)", Callable(self, "_tray_toggle_roam"))
	tray_menu.set_item_checked(tray_rid, idx_always, true)
	tray_menu.add_separator(tray_rid)
	tray_menu.add_item(tray_rid, "撫摸寵物 ❤", Callable(self, "_tray_pat"))
	tray_menu.add_item(tray_rid, "餵食美味小點心 🍣", Callable(self, "_tray_feed"))
	tray_menu.add_item(tray_rid, "開啟對話／設定", Callable(self, "_open_ui"))
	tray_menu.add_separator(tray_rid)
	tray_menu.add_item(tray_rid, "徹底退出 AuraPet (結束後台)", Callable(self, "_tray_quit"))
	var icon := load("res://icon.png") as Texture2D
	if icon == null:
		print("tray: icon failed to load")
		return
	tray_id = DisplayServer.create_status_indicator(icon, "AuraPet - AI 桌面夥伴", Callable(self, "_on_tray_pressed").unbind(2))
	if tray_id < 0:
		print("tray: create_status_indicator failed")
		return
	DisplayServer.status_indicator_set_menu(tray_id, tray_rid)
	print("tray: status indicator ready id=%d" % tray_id)

func _spawn_tray_helper() -> void:
	var exe_dir := OS.get_executable_path().get_base_dir()
	var script := ProjectSettings.globalize_path("res://tray_helper.py")
	# Exported builds have the pck embedded, so res:// has no real file on disk;
	# the packaging step ships the helper next to the executable instead.
	if not FileAccess.file_exists(script):
		script = exe_dir.path_join("tray_helper.py")
	if not FileAccess.file_exists(script):
		print("tray: helper script missing: %s" % script)
		return
	var icon := ProjectSettings.globalize_path("res://icon.png")
	if not FileAccess.file_exists(icon):
		icon = exe_dir.path_join("icon.png")
	tray_pid = OS.create_process("python3", PackedStringArray([
		script,
		"--port=%d" % port,
		"--ui-port=%d" % ui_port,
		"--config=%s" % config_path,
		"--icon=%s" % icon,
		"--parent-pid=%d" % OS.get_process_id()
	]))
	if tray_pid > 0:
		print("tray: Ayatana helper pid=%d" % tray_pid)
	else:
		print("tray: failed to spawn Ayatana helper")

func _on_tray_pressed() -> void:
	_set_visible(true)

func _tray_toggle_mode() -> void:
	send_event("mode.toggle")
	print("tray: mode.toggle")

func _tray_toggle_visible() -> void:
	_set_visible(not is_visible)

func _tray_toggle_top() -> void:
	_apply_always_on_top(not always_on_top)
	_sync_tray_checks()
	_report_window_state()
	print("tray: alwaysOnTop=%s" % always_on_top)

func _tray_toggle_roam() -> void:
	# Server accepts this from an authed body even though the contract lists
	# ui>brain; the tray is the body's own surface (see docs/ws-protocol.md #10).
	send_event("roam.set-enabled", {"enabled": not roam_enabled})
	print("tray: roam.set-enabled=%s" % (not roam_enabled))

func _tray_pat() -> void:
	send_event("interaction", {"kind": "pat", "source": "tray"})
	send_event("activity")
	rig.play_react("happy")
	_show_bubble("好舒服～", 1600)
	print("tray: pat")

func _tray_feed() -> void:
	send_event("interaction", {"kind": "feed", "source": "tray"})
	send_event("activity")
	rig.play_react("eating")
	_show_bubble("好好吃！", 1600)
	print("tray: feed")

func _tray_quit() -> void:
	_quit()

func _open_ui() -> void:
	OS.shell_open("http://127.0.0.1:%d/?token=%s" % [ui_port, token])
	print("ui: open http://127.0.0.1:%d/" % ui_port)

func _sync_tray_checks() -> void:
	if tray_menu == null or not tray_rid.is_valid():
		return
	if idx_always >= 0:
		tray_menu.set_item_checked(tray_rid, idx_always, always_on_top)
	if idx_roam >= 0:
		tray_menu.set_item_checked(tray_rid, idx_roam, roam_enabled)
	if idx_visible >= 0:
		tray_menu.set_item_label(tray_rid, idx_visible, "隱藏" if is_visible else "顯示")

func _run_selftest(which: String) -> void:
	match which:
		"tray":
			await get_tree().create_timer(1.5).timeout
			_tray_pat()
			await get_tree().create_timer(0.5).timeout
			_tray_feed()
			await get_tree().create_timer(0.5).timeout
			_tray_toggle_top()
			await get_tree().create_timer(0.5).timeout
			print("selftest: tray callbacks ok")
			_quit()
		_:
			print("selftest: unknown %s" % which)
			_quit()

# ---------------------------------------------------------------- bridge ---

func _connect_bridge() -> void:
	if token == "":
		push_error("body: no bridge token (pass --config or --token)")
		get_tree().quit(1)
		return
	ws = WebSocketPeer.new()
	var err := ws.connect_to_url("ws://127.0.0.1:%d" % port)
	conn_state = 1
	hello_sent = false
	handshake_started = 0.0
	print("bridge: connecting ws://127.0.0.1:%d" % port)
	if err != OK:
		print("bridge: connect_to_url error %d" % err)

func _poll_bridge(delta: float) -> void:
	if not bridge_enabled:
		return
	if ws == null:
		if Time.get_ticks_msec() >= next_connect_at:
			_connect_bridge()
		return
	ws.poll()
	var st := ws.get_ready_state()
	if st == WebSocketPeer.STATE_OPEN:
		if not hello_sent:
			hello_sent = true
			conn_state = 2
			handshake_started = Time.get_ticks_msec() / 1000.0
			_send({"v": PROTOCOL_VERSION, "id": hello_id, "t": "hello",
				"role": "body", "name": "godot-body", "version": "0.1.0",
				"protocol": PROTOCOL_VERSION, "token": token})
		while ws.get_available_packet_count() > 0:
			var packet := ws.get_packet()
			var text := packet.get_string_from_utf8()
			var msg = JSON.parse_string(text)
			if msg is Dictionary:
				_handle_message(msg)
		if conn_state == 2 and Time.get_ticks_msec() / 1000.0 - handshake_started > HELLO_TIMEOUT:
			print("bridge: hello timeout")
			_disconnect("hello timeout")
		ping_timer += delta
		if ping_timer >= PING_INTERVAL:
			ping_timer = 0.0
			send_event("ping", {"ts": int(Time.get_ticks_msec())})
		if Time.get_ticks_msec() / 1000.0 - last_pong > PONG_TIMEOUT:
			print("bridge: pong timeout, reconnecting")
			_disconnect("pong timeout")
	elif st == WebSocketPeer.STATE_CLOSED:
		_disconnect("closed")
	elif st == WebSocketPeer.STATE_CLOSING:
		pass

func _disconnect(reason: String) -> void:
	if ws != null:
		ws.close()
		ws = null
	conn_state = 0
	hello_sent = false
	next_connect_at = Time.get_ticks_msec() + int(reconnect_delay * 1000.0)
	reconnect_delay = minf(30.0, reconnect_delay * 2.0)
	print("bridge: disconnected (%s), retry in %.0fs" % [reason, reconnect_delay / 2.0])

func _send(message: Dictionary) -> void:
	if ws != null and ws.get_ready_state() == WebSocketPeer.STATE_OPEN:
		ws.send_text(JSON.stringify(message))

func send_event(t: String, payload: Dictionary = {}) -> void:
	var message := {"v": PROTOCOL_VERSION, "t": t}
	for k in payload:
		message[k] = payload[k]
	_send(message)

func _handle_message(msg: Dictionary) -> void:
	last_pong = Time.get_ticks_msec() / 1000.0
	if msg.has("id") and msg.has("ok"):
		if int(msg.id) == hello_id:
			if msg.ok:
				conn_state = 3
				reconnect_delay = 1.0
				last_pong = Time.get_ticks_msec() / 1000.0
				ping_timer = 0.0
				print("bridge: ready session=%s protocol=%s" % [msg.get("session", ""), msg.get("protocol", "")])
				_report_window_state()
			else:
				print("bridge: hello rejected: %s" % JSON.stringify(msg.get("error", {})))
				_disconnect("hello rejected")
		return
	if typeof(msg.get("t")) != TYPE_STRING:
		return
	_handle_event(msg.t, msg)

func _handle_event(t: String, msg: Dictionary) -> void:
	match t:
		"state.sync":
			_apply_state_sync(msg)
		"mode.set":
			_apply_mode(str(msg.mode), true)
		"window.apply":
			if msg.has("alwaysOnTop"):
				_apply_always_on_top(bool(msg.alwaysOnTop))
			if msg.has("clickThrough"):
				_apply_click_through(bool(msg.clickThrough))
			if msg.has("visible"):
				_set_visible(bool(msg.visible))
			_sync_tray_checks()
			_report_window_state()
		"window.minimize":
			_set_visible(false)
		"window.close":
			_quit()
		"roam.command":
			match str(msg.get("action", "")):
				"start":
					_start_roam()
				"stop", "park":
					_stop_roam(true)
		"roam.enabled":
			roam_enabled = bool(msg.enabled)
			if not roam_enabled:
				_stop_roam(true)
			_sync_tray_checks()
		"pose.set":
			posture = str(msg.get("posture", posture))
			if msg.has("skin"):
				skin = str(msg.skin)
			rig.set_posture(posture)
			print("pose: %s skin=%s" % [posture, skin])
		"react":
			var emotion := str(msg.get("emotion", ""))
			rig.play_react(emotion)
			print("react: %s" % emotion)
			if emotion == "eating":
				_show_bubble("好好吃！", 1400)
			elif emotion == "happy":
				_show_bubble("好開心～", 1400)
		"say":
			var ttl := int(msg.get("ttlMs", 3000))
			_show_bubble(str(msg.get("text", "")), maxi(400, ttl))
			print("say: %d chars ttl=%d" % [str(msg.get("text", "")).length(), ttl])
			if msg.get("speech") == true:
				print("say: speech requested but TTS is not wired in body v0")
		"sound.play":
			_play_sound(str(msg.get("clip", "")))
		"ping":
			if msg.get("id") != null:
				_send({"v": PROTOCOL_VERSION, "id": msg.id, "ok": true, "ts": msg.get("ts", 0)})
			else:
				send_event("pong", {"ts": int(Time.get_ticks_msec())})
		"pong":
			pass
		"bye":
			print("bridge: brain said bye (%s)" % msg.get("reason", ""))
			_disconnect("bye")
		_:
			pass

func _apply_state_sync(msg: Dictionary) -> void:
	if msg.has("alwaysOnTop"):
		_apply_always_on_top(bool(msg.alwaysOnTop))
	if msg.has("clickThrough"):
		_apply_click_through(bool(msg.clickThrough))
	if msg.has("roamEnabled"):
		roam_enabled = bool(msg.roamEnabled)
	if msg.has("nickname"):
		nickname = str(msg.nickname)
	if msg.has("skin"):
		skin = str(msg.skin)
	posture = str(msg.get("posture", posture))
	rig.set_posture(posture)
	_apply_mode(str(msg.get("mode", mode)), false)
	if msg.has("visibility"):
		_set_visible(bool(msg.visibility))
	_sync_tray_checks()
	_report_window_state()

func _apply_mode(next_mode: String, announce: bool) -> void:
	if next_mode != "pet" and next_mode != "chat":
		return
	if next_mode == mode:
		_apply_window_size(next_mode)
		return
	if mode == "pet":
		pet_pos = DisplayServer.window_get_position()
	mode = next_mode
	_apply_window_size(mode)
	if announce:
		send_event("mode.changed", {"mode": mode})
	print("body: mode=%s size=%s" % [mode, DisplayServer.window_get_size()])
	_report_window_state()

func _apply_window_size(m: String) -> void:
	if m == "chat":
		DisplayServer.window_set_size(CHAT_SIZE)
		var wa := DisplayServer.screen_get_usable_rect(DisplayServer.window_get_current_screen())
		var pos := wa.position + (wa.size - CHAT_SIZE) / 2
		DisplayServer.window_set_position(pos)
		rig.position = Vector2((CHAT_SIZE.x - 240) / 2, CHAT_SIZE.y - 290)
	else:
		DisplayServer.window_set_size(PET_SIZE)
		DisplayServer.window_set_position(pet_pos)
		rig.position = Vector2.ZERO
	_place_bubble()

func _apply_always_on_top(on: bool) -> void:
	always_on_top = on
	DisplayServer.window_set_flag(DisplayServer.WINDOW_FLAG_ALWAYS_ON_TOP, on)

func _apply_click_through(on: bool) -> void:
	click_through = on
	if on:
		# Empty disables passthrough; an off-window polygon passes every click.
		DisplayServer.window_set_mouse_passthrough(PackedVector2Array([Vector2(-1, -1)]))
	else:
		DisplayServer.window_set_mouse_passthrough(PackedVector2Array())
	print("body: clickThrough=%s" % on)

func _set_visible(show: bool) -> void:
	is_visible = show
	if show:
		if DisplayServer.window_get_mode() == DisplayServer.WINDOW_MODE_MINIMIZED:
			DisplayServer.window_set_mode(DisplayServer.WINDOW_MODE_WINDOWED)
		_apply_always_on_top(always_on_top)
		DisplayServer.window_move_to_foreground()
		paused = false
	else:
		_stop_roam(true)
		paused = true
		DisplayServer.window_set_mode(DisplayServer.WINDOW_MODE_MINIMIZED)
	_sync_tray_checks()
	_report_window_state()
	print("body: visible=%s" % show)

func _report_window_state() -> void:
	if conn_state != 3:
		return
	var pos := DisplayServer.window_get_position()
	send_event("window.state", {
		"alwaysOnTop": always_on_top,
		"clickThrough": click_through,
		"visible": is_visible,
		"x": pos.x,
		"y": pos.y
	})

func _play_sound(clip: String) -> void:
	if clip == "":
		return
	var path := "res://assets/%s" % clip
	if not ResourceLoader.exists(path):
		print("sound.play: clip not bundled: %s" % clip)
		return
	var player := AudioStreamPlayer.new()
	player.stream = load(path)
	player.finished.connect(player.queue_free)
	add_child(player)
	player.play()

# ------------------------------------------------------------------ say ---

func _show_bubble(text: String, ttl_ms: int) -> void:
	if text.strip_edges() == "":
		return
	bubble_label.text = text
	bubble_timer = ttl_ms / 1000.0
	bubble_panel.visible = true
	bubble_panel.modulate.a = 1.0
	_place_bubble()

func _place_bubble() -> void:
	if bubble_panel == null or not bubble_panel.visible:
		return
	var size := DisplayServer.window_get_size()
	bubble_panel.reset_size()
	bubble_panel.position = Vector2(roundf((size.x - bubble_panel.size.x) * 0.5), 4)

# ----------------------------------------------------------------- roam ---

func _start_roam() -> void:
	if roaming or not is_visible:
		send_event("roam.state", {"state": "idle", "x": DisplayServer.window_get_position().x, "y": DisplayServer.window_get_position().y})
		return
	var pos := DisplayServer.window_get_position()
	var wa := DisplayServer.screen_get_usable_rect(DisplayServer.window_get_current_screen())
	var max_x := wa.position.x + wa.size.x - PET_SIZE.x
	if max_x < wa.position.x:
		send_event("roam.state", {"state": "idle", "x": pos.x, "y": pos.y})
		return
	var target_x := pos.x
	for i in range(4):
		target_x = randi_range(wa.position.x, max_x)
		if absi(target_x - pos.x) >= ROAM.minDistance:
			break
	if absi(target_x - pos.x) < ROAM.minDistance:
		send_event("roam.state", {"state": "idle", "x": pos.x, "y": pos.y})
		return
	roam_start_x = pos.x
	roam_start_y = pos.y
	roam_dx = target_x - pos.x
	roam_dur = clampi(int(absf(roam_dx) / ROAM.speed * 1000.0), 900, 24000)
	roam_start = Time.get_ticks_msec()
	roam_tick_acc = 0.0
	roaming = true
	rig.set_walking(true)
	send_event("roam.state", {"state": "walk-right" if roam_dx > 0 else "walk-left", "x": pos.x, "y": pos.y})
	print("roam: start x=%d target=%d dur=%dms" % [pos.x, target_x, roam_dur])

func _stop_roam(send_idle: bool) -> void:
	if not roaming and not roam_forced:
		if send_idle and conn_state == 3:
			var pos := DisplayServer.window_get_position()
			send_event("roam.state", {"state": "idle", "x": pos.x, "y": pos.y})
		return
	roaming = false
	if not roam_forced:
		rig.set_walking(false)
	if send_idle:
		var pos := DisplayServer.window_get_position()
		send_event("roam.state", {"state": "idle", "x": pos.x, "y": pos.y})
		_report_window_state()
	print("roam: stop")

func _roam_tick() -> void:
	if not roaming:
		return
	var now := Time.get_ticks_msec() * 1.0
	var t := clampf((now - roam_start) / roam_dur, 0.0, 1.0)
	var ramp := 0.15
	var cruise := 1.0 / (1.0 - ramp)
	var eased := 0.0
	if t < ramp:
		eased = cruise * t * t / (2.0 * ramp)
	elif t > 1.0 - ramp:
		var u := 1.0 - t
		eased = 1.0 - cruise * u * u / (2.0 * ramp)
	else:
		eased = cruise * (ramp / 2.0 + (t - ramp))
	DisplayServer.window_set_position(Vector2i(int(round(roam_start_x + roam_dx * eased)), roam_start_y))
	if t >= 1.0:
		roaming = false
		if not roam_forced:
			rig.set_walking(false)
		var pos := DisplayServer.window_get_position()
		send_event("roam.state", {"state": "idle", "x": pos.x, "y": pos.y})
		_report_window_state()
		print("roam: arrived x=%d" % pos.x)

# ---------------------------------------------------------------- input ---

func _input(event: InputEvent) -> void:
	if event is InputEventMouseButton and event.button_index == MOUSE_BUTTON_LEFT:
		if event.pressed:
			left_down = true
			left_dragging = false
			press_global = DisplayServer.mouse_get_position()
			press_window = DisplayServer.window_get_position()
			send_event("activity")
		else:
			left_down = false
			if left_dragging:
				left_dragging = false
				if mode == "pet":
					pet_pos = DisplayServer.window_get_position()
				_report_window_state()
			else:
				send_event("interaction", {"kind": "click", "source": "window"})
				rig.play_react("happy")
				print("interaction: click")
		return
	if event is InputEventMouseMotion and left_down:
		var now_pos := DisplayServer.mouse_get_position()
		var delta := now_pos - press_global
		if not left_dragging and delta.length() > 3.0:
			left_dragging = true
		if left_dragging:
			DisplayServer.window_set_position(press_window + delta)

# ----------------------------------------------------------------- loop ---

func _process(delta: float) -> void:
	elapsed += delta
	_poll_bridge(delta)
	if shot_path != "" and not shot_done and elapsed >= shot_after:
		shot_done = true
		_take_shot()
		return
	if not paused:
		if roaming:
			roam_tick_acc += delta
			while roam_tick_acc >= ROAM.tick:
				roam_tick_acc -= ROAM.tick
				_roam_tick()
		anim_acc += delta
		var interval := ACTIVE_FRAME if fixed_rate > 0.0 else frame_interval
		if fixed_rate > 0.0:
			interval = 1.0 / fixed_rate
		if anim_acc >= interval:
			var dt := minf(anim_acc, 0.15)
			anim_acc = 0.0
			rig.step(dt)
			draws += 1
			stat_t += dt
			if stat_t >= 5.0:
				print("body draws/s=%.1f" % (draws / stat_t))
				draws = 0
				stat_t = 0.0
			if fixed_rate <= 0.0:
				frame_interval = rig.frame_interval()
				if roaming:
					frame_interval = minf(frame_interval, ACTIVE_FRAME)
			if lowproc:
				OS.low_processor_usage_mode_sleep_usec = 10000 if frame_interval < 0.05 else 70000
	if bubble_timer > 0.0:
		bubble_timer -= delta
		if bubble_timer <= 0.3:
			bubble_panel.modulate.a = maxf(0.0, bubble_timer / 0.3)
		if bubble_timer <= 0.0:
			bubble_panel.visible = false
	_place_bubble()

func _take_shot() -> void:
	var img := get_viewport().get_texture().get_image()
	var err := img.save_png(shot_path)
	print("shot: %s err=%d size=%s" % [shot_path, err, img.get_size()])
	_quit()

func _notification(what: int) -> void:
	if what == NOTIFICATION_WM_CLOSE_REQUEST:
		_quit()

func _quit() -> void:
	send_event("bye", {"reason": "body closing"})
	if ws != null:
		ws.close()
	get_tree().quit()

func _exit_tree() -> void:
	if tray_pid > 0:
		OS.kill(tray_pid)
		tray_pid = -1
	if tray_id >= 0:
		DisplayServer.delete_status_indicator(tray_id)
		tray_id = -1
	if tray_menu != null and tray_rid.is_valid():
		tray_menu.free_menu(tray_rid)
