import QtQuick
import qs.Commons
import qs.Ui
import "../lib/model.mjs" as Model

// SnapWeb's Settings dialog (server, show offline) plus what a desktop
// client needs: ports, authentication, cover-art privacy, local playback.
// Server fields apply on Save (they restart the helper); toggles apply at once.
Column {
  id: root
  property var app: null
  readonly property var service: app ? app.service : null
  readonly property var s: service ? service.settings : Model.normalizeSettings({})

  property string host: ""
  property string port: ""
  property string httpPort: ""
  property string streamPort: ""
  property string username: ""
  property string password: ""
  property bool passwordStored: false
  property string error: ""
  property string localHostId: ""
  property var soundcards: []
  property string saved: ""

  spacing: Style.space(12)

  Component.onCompleted: {
    host = s.host
    port = String(s.port)
    httpPort = String(s.httpPort)
    streamPort = String(s.streamPort)
    username = s.username
    localHostId = s.localHostId
    if (service && s.username !== "") service.hasPassword(function(stored) { root.passwordStored = stored })
    loadSoundcards()
  }

  function loadSoundcards() {
    if (!service) return
    service.listSoundcards(s.localPlayer, function(list) { root.soundcards = list })
  }

  readonly property bool dirty: host.trim() !== s.host || port !== String(s.port) || httpPort !== String(s.httpPort)
    || streamPort !== String(s.streamPort) || username.trim() !== s.username || password !== ""
    || localHostId.trim() !== s.localHostId

  function save() {
    var h = host.trim()
    if (h !== "" && !Model.validHost(h)) { error = app.strings.t("settings.invalidHost"); return }
    var ports = [port, httpPort, streamPort]
    for (var i = 0; i < ports.length; i++) if (!Model.validPort(ports[i])) { error = app.strings.t("settings.invalidPort"); return }
    var u = username.trim()
    if (!/^[A-Za-z0-9_.@-]{0,64}$/.test(u)) { error = app.strings.t("settings.invalidUser"); return }
    var hid = localHostId.trim()
    if (!/^[A-Za-z0-9._:-]{0,64}$/.test(hid)) { error = app.strings.t("settings.invalidHostId"); return }
    error = ""
    var pw = password
    service.updateSettings({ host: h, port: Number(port), httpPort: Number(httpPort), streamPort: Number(streamPort), username: u, localHostId: hid })
    password = ""
    saved = app.strings.t("settings.saved")
    savedTimer.restart()
    // The password goes to the keyring once the helper runs with the new host/user.
    if (pw !== "" && u !== "") passwordTimer.pending = pw
    if (pw !== "" && u !== "") passwordTimer.restart()
  }

  Timer {
    id: savedTimer
    interval: 3000
    onTriggered: root.saved = ""
  }
  Timer {
    id: passwordTimer
    property string pending: ""
    interval: 1200
    onTriggered: {
      var pw = pending
      pending = ""
      root.service.setPassword(pw, function(ok, result) {
        if (ok) root.passwordStored = true
        else root.error = String(result)
      })
    }
  }

  // ---------------------------------------------------------------- server
  PanelSectionHeader {
    text: root.app.strings.t("settings.server")
    foreground: root.app.fg
    fontFamily: root.app.fontFamily
  }

  FormField {
    width: parent.width
    app: root.app
    label: root.app.strings.t("settings.host")
    hint: root.app.strings.t("settings.hostHint")
    Field {
      app: root.app
      text: root.host
      maximumLength: 253
      placeholderText: "snapserver.local"
      onTextChanged: root.host = text
      onAccepted: root.save()
    }
  }

  Row {
    width: parent.width
    spacing: Style.space(8)
    Repeater {
      model: [
        { key: "port", label: root.app.strings.t("settings.port") },
        { key: "httpPort", label: root.app.strings.t("settings.httpPort") },
        { key: "streamPort", label: root.app.strings.t("settings.streamPort") }
      ]
      FormField {
        required property var modelData
        width: (root.width - Style.space(16)) / 3
        app: root.app
        label: modelData.label
        Field {
          app: root.app
          text: root[modelData.key]
          maximumLength: 5
          inputMethodHints: Qt.ImhDigitsOnly
          onTextChanged: root[modelData.key] = text
          onAccepted: root.save()
        }
      }
    }
  }

  Row {
    width: parent.width
    spacing: Style.space(8)
    FormField {
      width: (parent.width - Style.space(8)) / 2
      app: root.app
      label: root.app.strings.t("settings.username")
      Field {
        app: root.app
        text: root.username
        maximumLength: 64
        placeholderText: root.app.strings.t("settings.optional")
        onTextChanged: root.username = text
      }
    }
    FormField {
      width: (parent.width - Style.space(8)) / 2
      app: root.app
      label: root.app.strings.t("settings.password")
      hint: root.passwordStored ? root.app.strings.t("settings.passwordStored") : ""
      Field {
        app: root.app
        password: true
        text: root.password
        maximumLength: 256
        enabled: root.username.trim() !== ""
        placeholderText: root.passwordStored ? "••••••" : root.app.strings.t("settings.optional")
        onTextChanged: root.password = text
        onAccepted: root.save()
      }
    }
  }

  PlainText {
    width: parent.width
    visible: root.error !== "" || root.saved !== ""
    text: root.error !== "" ? root.error : root.saved
    wrapMode: Text.Wrap
    color: root.error !== "" ? root.app.urgent : root.app.accent
    font.family: root.app.fontFamily
    font.pixelSize: Style.font.bodySmall
  }

  InfoRow {
    width: parent.width
    app: root.app
    label: root.app.strings.t("settings.connection")
    value: root.service ? root.app.strings.t("settings.state." + root.service.connectionState, root.service.connectionState)
      + (root.service.connectionError !== "" && !root.service.connected ? " — " + root.service.connectionError : "") : ""
  }

  ActionRow {
    width: parent.width
    app: root.app
    okText: root.app.strings.t("settings.save")
    cancelText: root.app.strings.t("common.back")
    okEnabled: root.dirty
    onCancel: root.app.back()
    onOk: root.save()
  }

  PanelSeparator { foreground: root.app.fg }

  // --------------------------------------------------------------- display
  PanelSectionHeader {
    text: root.app.strings.t("settings.display")
    foreground: root.app.fg
    fontFamily: root.app.fontFamily
  }

  Toggle {
    width: parent.width
    label: root.app.strings.t("settings.hideOffline")
    checked: root.s.hideOffline
    foreground: root.app.fg
    fontFamily: root.app.fontFamily
    titleSize: Style.font.body
    onClicked: root.service.updateSetting("hideOffline", !root.s.hideOffline)
  }
  Toggle {
    width: parent.width
    label: root.app.strings.t("settings.showMetadata")
    checked: root.s.showMetadata
    foreground: root.app.fg
    fontFamily: root.app.fontFamily
    titleSize: Style.font.body
    onClicked: root.service.updateSetting("showMetadata", !root.s.showMetadata)
  }
  FormField {
    width: parent.width
    app: root.app
    label: root.app.strings.t("settings.coverArt")
    hint: root.app.strings.t("settings.coverArtHint." + root.s.coverArt)
    ButtonGroup {
      width: parent.width
      options: Model.ART_POLICIES.map(function(p) { return { value: p, label: root.app.strings.t("settings.coverArt." + p) } })
      value: root.s.coverArt
      foreground: root.app.fg
      background: root.app.panelBackground
      fontFamily: root.app.fontFamily
      onChanged: function(v) { root.service.updateSetting("coverArt", v) }
    }
  }

  PanelSeparator { foreground: root.app.fg }

  // ----------------------------------------------------------------- local
  PanelSectionHeader {
    text: root.app.strings.t("settings.local")
    foreground: root.app.fg
    fontFamily: root.app.fontFamily
  }

  PlainText {
    width: parent.width
    visible: root.service && !root.service.local.available
    text: root.app.strings.t("settings.noSnapclient")
    wrapMode: Text.Wrap
    color: root.app.urgent
    font.family: root.app.fontFamily
    font.pixelSize: Style.font.bodySmall
  }

  Toggle {
    width: parent.width
    label: root.app.strings.t("settings.localPlayback")
    description: root.service ? root.app.strings.t("local.state." + root.service.local.state, root.service.local.state)
      + (root.service.localClientId !== "" ? " · " + root.service.localClientId : "") : ""
    checked: root.s.localPlayback
    enabled: root.service && root.service.configured
    foreground: root.app.fg
    fontFamily: root.app.fontFamily
    titleSize: Style.font.body
    onClicked: root.service.setLocalPlayback(!root.s.localPlayback)
  }

  FormField {
    width: parent.width
    app: root.app
    label: root.app.strings.t("settings.backend")
    ButtonGroup {
      width: parent.width
      options: Model.PLAYERS.map(function(p) { return { value: p, label: root.app.strings.t("settings.player." + p, p) } })
      value: root.s.localPlayer
      foreground: root.app.fg
      background: root.app.panelBackground
      fontFamily: root.app.fontFamily
      onChanged: function(v) {
        root.service.updateSettings({ localPlayer: v, localSoundcard: "" })
        Qt.callLater(root.loadSoundcards)
      }
    }
  }

  FormField {
    width: parent.width
    app: root.app
    label: root.app.strings.t("settings.soundcard")
    Dropdown {
      width: parent.width
      showLabel: false
      value: root.s.localSoundcard
      options: [{ value: "", label: root.app.strings.t("settings.soundcardDefault") }].concat(root.soundcards)
      foreground: root.app.fg
      background: root.app.panelBackground
      fontFamily: root.app.fontFamily
      onChanged: function(v) { root.service.updateSetting("localSoundcard", v) }
    }
  }

  Row {
    width: parent.width
    spacing: Style.space(8)
    NumberField {
      width: (parent.width - Style.space(8)) / 2
      label: root.app.strings.t("settings.latency")
      value: root.s.localLatency
      from: 0
      to: 2000
      stepSize: 10
      foreground: root.app.fg
      fontFamily: root.app.fontFamily
      onModified: function(v) { latencySave.value = v; latencySave.restart() }
      Timer {
        id: latencySave
        property int value: 0
        interval: 600
        onTriggered: root.service.updateSetting("localLatency", value)
      }
    }
    FormField {
      width: (parent.width - Style.space(8)) / 2
      app: root.app
      label: root.app.strings.t("settings.hostId")
      Field {
        app: root.app
        text: root.localHostId
        maximumLength: 64
        placeholderText: root.service ? root.service.localClientId : ""
        onTextChanged: root.localHostId = text
        onAccepted: root.save()
      }
    }
  }

  PanelSeparator { foreground: root.app.fg }

  // ----------------------------------------------------------------- about
  PanelSectionHeader {
    text: root.app.strings.t("settings.about")
    foreground: root.app.fg
    fontFamily: root.app.fontFamily
  }
  Column {
    width: parent.width
    spacing: Style.space(6)
    InfoRow { width: parent.width; app: root.app; label: root.app.strings.t("about.plugin"); value: "Snapcast Control " + (root.app.service && root.app.service.manifest ? root.app.service.manifest.version : "") }
    InfoRow { width: parent.width; app: root.app; label: root.app.strings.t("about.server"); value: root.service ? (root.service.server.server.snapserver.name + " " + root.service.server.server.snapserver.version).trim() : "" }
    InfoRow { width: parent.width; app: root.app; label: root.app.strings.t("about.serverHost"); value: root.service ? (root.service.server.server.host.name + (root.service.server.server.host.os !== "" ? " · " + root.service.server.server.host.os : "")) : "" }
    InfoRow { width: parent.width; app: root.app; label: root.app.strings.t("about.rpc"); value: root.service ? root.service.rpcVersion : "" }
    InfoRow { width: parent.width; app: root.app; label: root.app.strings.t("about.snapclient"); value: root.service ? root.service.local.version : "" }
    InfoRow { width: parent.width; app: root.app; label: root.app.strings.t("about.log"); value: root.service ? root.service.stateDir + "/logs/helper.log" : "" }
  }
}
