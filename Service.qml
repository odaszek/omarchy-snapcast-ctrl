import QtQuick
import Quickshell
import Quickshell.Io
import "lib/model.mjs" as Model

// Long-lived service (manifest: kind "service", keepLoaded). Owns the Deno
// helper that holds the Snapcast connection and the local snapclient, so the
// connection survives bar reloads and runs whether or not a panel is open.
//
// The bar widget (one per screen) reads state from here and calls its
// functions. Settings live in the widget's inline entry in shell.json.
Item {
  id: root

  // Set by the shell after creation (see PluginShellApi).
  property var shell: null
  property var manifest: null

  readonly property string pluginId: "odach.snapcast-ctrl"
  readonly property string pluginDir: String(Qt.resolvedUrl(".")).replace(/^file:\/\//, "").replace(/\/+$/, "")
  readonly property string home: Quickshell.env("HOME") || ""
  readonly property string stateDir: (Quickshell.env("XDG_STATE_HOME") || home + "/.local/state") + "/omarchy/snapcast-ctrl"

  // ---- settings ----
  // The widget's inline entry in shell.json. The shell refreshes a plugin's
  // `barConfig` only when plugins change, not when shell.json is edited, so
  // the file itself is watched; `barConfig` covers the time before it loads.
  readonly property string shellJsonPath: (Quickshell.env("XDG_CONFIG_HOME") || home + "/.config") + "/omarchy/shell.json"
  property var fileSettings: null
  readonly property var rawSettings: fileSettings !== null ? fileSettings
    : Model.findEntrySettings(shell ? shell.barConfig : null, pluginId)

  FileView {
    id: shellFile
    path: root.shellJsonPath
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: root.readShellJson(text())
    onLoadFailed: root.fileSettings = null
  }

  function readShellJson(text) {
    if (typeof text !== "string" || text.length > 4 * 1024 * 1024) return
    var parsed
    try {
      parsed = JSON.parse(text)
    } catch (e) {
      return // mid-write or hand-edit typo: keep the last good settings
    }
    var entry = Model.findEntrySettings(parsed && parsed.bar ? parsed.bar : null, pluginId)
    if (JSON.stringify(entry) !== JSON.stringify(fileSettings)) fileSettings = entry
  }
  readonly property var settings: Model.normalizeSettings(rawSettings)
  readonly property bool configured: settings.host !== ""

  // Anything that changes how the helper must be started (its network
  // permission is fixed at start) restarts it.
  readonly property string launchKey: JSON.stringify([settings.host, settings.port, settings.httpPort,
    settings.streamPort, settings.coverArt, settings.username])

  // ---- state published to the widgets ----
  property bool helperReady: false
  property string helperError: ""
  property string connectionState: "idle"   // idle|connecting|connected|disconnected|unconfigured
  property string connectionError: ""
  property string rpcVersion: ""
  property var server: Model.emptyServer()
  // Group ids in display order. Reassigned only when the list changes, so
  // the panel's delegates (and a slider being dragged) are not rebuilt on
  // every volume notification.
  property var groupIds: []
  property string lastWarning: ""
  property var local: ({ state: "stopped", available: false, version: "", clientId: "", error: "" })
  property string localClientId: ""

  readonly property bool connected: connectionState === "connected"
  readonly property bool playing: connected && Model.anyPlaying(server)
  readonly property var targetGroup: Model.targetGroup(server, localRunning ? localClientId : "", settings.hideOffline)
  readonly property bool localRunning: local.state === "running" || local.state === "starting" || local.state === "restarting"

  signal panelRequested()

  Timer {
    id: warningTimer
    interval: 30 * 1000
    onTriggered: root.lastWarning = ""
  }

  // ---- helper process ----
  property int nextRequestId: 1
  property var pending: ({})
  property int restartAttempt: 0
  property bool stopping: false
  property bool relaunch: false

  Process {
    id: helper
    command: {
      var s = root.settings
      var args = ["bash", root.pluginDir + "/helper/start.sh", root.stateDir, Model.netAllowList(s), "snapclient",
        "--host", s.host, "--port", String(s.port), "--http-port", String(s.httpPort),
        "--stream-port", String(s.streamPort), "--art", s.coverArt]
      if (s.username !== "") args.push("--username", s.username)
      return args
    }
    stdinEnabled: true

    stdout: SplitParser {
      onRead: data => root.handleLine(data)
    }
    // The helper logs to <state>/logs/helper.log; warnings reach the panel as "log" events.
    stderr: SplitParser {
      onRead: data => {}
    }

    onExited: (exitCode, exitStatus) => {
      root.helperReady = false
      root.connectionState = "idle"
      root.failPending("helper exited")
      if (root.relaunch) {
        root.relaunch = false
        root.stopping = false
        root.restartAttempt = 0
        restartTimer.interval = 50
        restartTimer.restart()
        return
      }
      if (root.stopping) return
      if (exitCode === 127) return // deno missing: the fatal event explained it
      if (root.helperError === "") root.helperError = "Snapcast helper stopped (exit " + exitCode + "); restarting"
      restartTimer.interval = Math.min(60000, 2000 * Math.pow(2, Math.min(root.restartAttempt, 5)))
      root.restartAttempt++
      restartTimer.restart()
    }
  }

  Timer {
    id: restartTimer
    repeat: false
    onTriggered: root.startHelper()
  }

  Timer {
    interval: 60000
    running: root.helperReady
    onTriggered: root.restartAttempt = 0
  }

  // Settings typed into the panel arrive one key at a time; restart once.
  Timer {
    id: relaunchTimer
    interval: 400
    onTriggered: root.restartHelper()
  }
  onLaunchKeyChanged: if (helper.running || helperReady) relaunchTimer.restart()

  function startHelper() {
    if (helper.running) return
    stopping = false
    helperError = ""
    helper.running = true
  }

  function restartHelper() {
    if (!helper.running) {
      startHelper()
      return
    }
    relaunch = true
    stopping = true
    helper.running = false
  }

  Component.onCompleted: startHelper()
  Component.onDestruction: {
    stopping = true
    helper.running = false
  }

  function handleLine(line) {
    if (line.length === 0 || line.length > 8 * 1024 * 1024) return
    var msg
    try {
      msg = JSON.parse(line)
    } catch (e) {
      return
    }
    if (!msg || typeof msg !== "object") return

    if (msg.id !== undefined && msg.id !== null && msg.event === undefined) {
      var cb = pending[msg.id]
      if (cb) {
        delete pending[msg.id]
        cb(msg.ok === true, msg.ok === true ? msg.result : String(msg.error || "request failed"))
      }
      return
    }

    switch (msg.event) {
    case "ready":
      helperReady = true
      helperError = ""
      refreshLocal()
      break
    case "connection":
      connectionState = String(msg.state || "idle")
      connectionError = String(msg.error || "").slice(0, 300)
      rpcVersion = String(msg.rpcVersion || "")
      break
    case "status":
      setServer(msg.server)
      break
    case "local":
      local = {
        state: String(msg.state || "stopped"),
        available: msg.available === true,
        version: String(msg.version || ""),
        clientId: String(msg.clientId || ""),
        error: String(msg.error || "").slice(0, 300)
      }
      if (local.clientId !== "") localClientId = local.clientId
      break
    case "fatal":
      helperError = String(msg.error || "Snapcast helper failed").slice(0, 300)
      break
    case "log":
      if (msg.level === "error" || msg.level === "warn") {
        lastWarning = String(msg.message || "").slice(0, 300)
        warningTimer.restart()
      }
      break
    }
  }

  function setServer(raw) {
    // The helper already normalized it; normalize again here so the views
    // can rely on the shape even if the helper misbehaves.
    var next = Model.normalizeServer(raw)
    for (var i = 0; i < next.streams.length; i++) {
      var file = raw && raw.streams && raw.streams[i] ? String(raw.streams[i].artFile || "") : ""
      // Only files the helper wrote into its own art cache.
      next.streams[i].artFile = file.indexOf(stateDir + "/art/") === 0 && file.indexOf("..") === -1 ? file : ""
    }
    server = next
    var ids = Model.visibleGroups(next, settings.hideOffline).map(function(g) { return g.id })
    if (ids.join("\n") !== groupIds.join("\n")) groupIds = ids
  }

  onSettingsChanged: {
    var ids = Model.visibleGroups(server, settings.hideOffline).map(function(g) { return g.id })
    if (ids.join("\n") !== groupIds.join("\n")) groupIds = ids
  }

  function request(op, params, callback) {
    if (!helper.running) {
      if (callback) callback(false, "helper is not running")
      return
    }
    var id = nextRequestId++
    var payload = Object.assign({}, params || {}, { id: id, op: op })
    if (callback) pending[id] = callback
    helper.write(JSON.stringify(payload) + "\n")
  }

  // Fire-and-forget with failures shown in the panel footer.
  function act(op, params, done) {
    request(op, params, function(ok, result) {
      if (!ok) {
        lastWarning = String(result).slice(0, 300)
        warningTimer.restart()
      }
      if (done) done(ok, result)
    })
  }

  function failPending(reason) {
    var old = pending
    pending = ({})
    for (var id in old) {
      try { old[id](false, reason) } catch (e) {}
    }
  }

  // ---- lookups for the views ----
  function group(id) { return Model.findGroup(server, id) }
  function client(id) { return Model.findClient(server, id) }
  function stream(id) { return Model.findStream(server, id) }

  // ---- operations ----
  function reconnect() { request("reconnect", {}) }
  function setClientVolume(clientId, percent) { act("setClientVolume", { clientId: clientId, percent: Math.round(percent) }) }
  function setClientMuted(clientId, muted) { act("setClientVolume", { clientId: clientId, muted: muted }) }
  function setVolumes(list) { act("setVolumes", { volumes: list }) }
  function setClientName(clientId, name, done) { act("setClientName", { clientId: clientId, name: name }, done) }
  function setClientLatency(clientId, latency, done) { act("setClientLatency", { clientId: clientId, latency: latency }, done) }
  function deleteClient(clientId, done) { act("deleteClient", { clientId: clientId }, done) }
  function setGroupMute(groupId, mute) { act("setGroupMute", { groupId: groupId, mute: mute }) }
  function setGroupName(groupId, name, done) { act("setGroupName", { groupId: groupId, name: name }, done) }
  function setGroupStream(groupId, streamId, done) { act("setGroupStream", { groupId: groupId, streamId: streamId }, done) }
  function setGroupClients(groupId, clients, done) { act("setGroupClients", { groupId: groupId, clients: clients }, done) }
  function streamControl(streamId, command, params) { act("streamControl", { streamId: streamId, command: command, params: params || {} }) }
  function streamSetProperty(streamId, property, value) { act("streamSetProperty", { streamId: streamId, property: property, value: value }) }
  function addStream(spec, done) { request("addStream", { spec: spec }, done) }
  function removeStream(streamId, done) { act("removeStream", { streamId: streamId }, done) }

  function playPause(streamId) {
    var st = stream(streamId)
    if (!st) return
    streamControl(streamId, st.properties.playbackStatus === "playing" ? "pause" : "play")
  }

  // Scroll on the bar icon: move the target group's volume by `steps`.
  function nudgeVolume(steps) {
    var g = targetGroup
    if (!g) return
    var snap = Model.volumeSnapshot(g, settings.hideOffline)
    if (snap.length === 0) return
    var avg = 0
    for (var i = 0; i < snap.length; i++) avg += snap[i].percent
    avg /= snap.length
    var value = Math.max(0, Math.min(100, avg + steps * settings.volumeStep))
    if (snap.length === 1) setClientVolume(snap[0].id, value)
    else setVolumes(Model.groupVolumeTargets(snap, value))
  }

  // ---- local playback ----
  function localOptions() {
    return { player: settings.localPlayer, soundcard: settings.localSoundcard, latency: settings.localLatency, hostId: settings.localHostId }
  }

  readonly property string localKey: JSON.stringify([settings.localPlayback, settings.localPlayer, settings.localSoundcard,
    settings.localLatency, settings.localHostId, helperReady])
  onLocalKeyChanged: localTimer.restart()
  Timer {
    id: localTimer
    interval: 300
    onTriggered: root.refreshLocal()
  }

  function refreshLocal() {
    if (!helperReady) return
    request("localClientId", localOptions(), function(ok, result) {
      if (ok) root.localClientId = String(result.clientId || "")
    })
    if (settings.localPlayback && configured) act("localStart", localOptions())
    else request("localStop", {})
  }

  function setLocalPlayback(on) {
    updateSetting("localPlayback", on === true)
  }

  function listSoundcards(player, done) {
    request("listSoundcards", { player: player }, function(ok, result) {
      done(ok ? (result.soundcards || []) : [])
    })
  }

  // ---- credentials ----
  function setPassword(password, done) { request("setPassword", { password: password }, done) }
  function hasPassword(done) {
    request("hasPassword", {}, function(ok, result) { done(ok && result.stored === true) })
  }

  // ---- settings (this widget's inline shell.json entry) ----
  function updateSettings(changes) {
    if (!shell || typeof shell.updateEntryInline !== "function") return false
    var next = Object.assign({}, rawSettings)
    delete next.id
    for (var k in changes) next[k] = changes[k]
    return shell.updateEntryInline(pluginId, next)
  }

  function updateSetting(key, value) {
    var c = {}
    c[key] = value
    return updateSettings(c)
  }
}
