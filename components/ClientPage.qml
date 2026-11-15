import QtQuick
import qs.Commons
import qs.Commons as Commons
import qs.Ui
import "../lib/model.mjs" as Model

// SnapWeb's "Client settings" dialog: name, latency (applied live, reverted
// on Cancel), read-only details, and Delete for offline clients.
Column {
  id: root
  property var app: null
  property string clientId: ""
  readonly property var service: app ? app.service : null
  readonly property var client: service ? Model.findClient(service.server, clientId) : null

  property string name: ""
  property int latency: 0
  property int originalLatency: 0
  property bool busy: false

  spacing: Style.space(12)

  property bool initialized: false
  Component.onCompleted: reset()
  onClientChanged: if (!initialized) reset()
  function reset() {
    if (!client) return
    initialized = true
    name = client.config.name
    latency = client.config.latency
    originalLatency = client.config.latency
  }

  function cancel() {
    if (client && latency !== originalLatency) service.setClientLatency(clientId, originalLatency)
    app.back()
  }

  function apply() {
    if (!client) {
      app.back()
      return
    }
    var trimmed = name.trim()
    if (trimmed !== client.config.name) {
      busy = true
      service.setClientName(clientId, trimmed, function() {
        root.busy = false
        root.app.back()
      })
    } else {
      app.back()
    }
  }

  function since(sec) {
    if (!sec) return ""
    return new Date(sec * 1000).toLocaleString(Qt.locale(Commons.I18n.formatLocale), Locale.ShortFormat)
  }

  PlainText {
    width: parent.width
    visible: !root.client
    text: root.app.strings.t("client.gone")
    color: root.app.dim
    font.family: root.app.fontFamily
    font.pixelSize: Style.font.body
  }

  FormField {
    width: parent.width
    visible: !!root.client
    app: root.app
    label: root.app.strings.t("client.name")
    Field {
      app: root.app
      text: root.name
      maximumLength: 128
      placeholderText: root.client ? root.client.host.name : ""
      onTextChanged: root.name = text
      onAccepted: root.apply()
    }
  }

  NumberField {
    width: parent.width
    visible: !!root.client
    label: root.app.strings.t("client.latency")
    value: root.latency
    from: -2000
    to: 2000
    stepSize: 5
    foreground: root.app.fg
    fontFamily: root.app.fontFamily
    onModified: function(v) {
      root.latency = v
      latencyTimer.restart()
    }
    Timer {
      id: latencyTimer
      interval: 250
      onTriggered: if (root.client) root.service.setClientLatency(root.clientId, root.latency)
    }
  }

  Column {
    width: parent.width
    visible: !!root.client
    spacing: Style.space(6)
    InfoRow { width: parent.width; app: root.app; label: root.app.strings.t("client.status"); value: root.client ? (root.client.connected ? root.app.strings.t("client.online") : root.app.strings.t("client.offlineSince").arg(root.since(root.client.lastSeen))) : "" }
    InfoRow { width: parent.width; app: root.app; label: root.app.strings.t("client.software"); value: root.client ? (root.client.snapclient.name + " " + root.client.snapclient.version).trim() : "" }
    InfoRow { width: parent.width; app: root.app; label: root.app.strings.t("client.mac"); value: root.client ? root.client.host.mac : "" }
    InfoRow { width: parent.width; app: root.app; label: root.app.strings.t("client.id"); value: root.clientId }
    InfoRow { width: parent.width; app: root.app; label: root.app.strings.t("client.ip"); value: root.client ? root.client.host.ip : "" }
    InfoRow { width: parent.width; app: root.app; label: root.app.strings.t("client.host"); value: root.client ? root.client.host.name : "" }
    InfoRow { width: parent.width; app: root.app; label: root.app.strings.t("client.os"); value: root.client ? root.client.host.os : "" }
    InfoRow { width: parent.width; app: root.app; label: root.app.strings.t("client.arch"); value: root.client ? root.client.host.arch : "" }
  }

  // SnapWeb offers Delete only for clients that are not connected.
  Button {
    visible: !!root.client && !root.client.connected
    text: root.app.strings.t("client.delete")
    iconText: Model.ICON.remove
    focusable: true
    bordered: true
    foreground: root.app.urgent
    fontFamily: root.app.fontFamily
    onClicked: root.app.confirm(root.app.strings.t("client.deleteConfirm").arg(Model.clientName(root.client)),
      root.app.strings.t("client.delete"), function() {
        root.service.deleteClient(root.clientId, function() { root.app.go("main", "", true) })
      })
  }

  ActionRow {
    width: parent.width
    visible: !!root.client
    app: root.app
    busy: root.busy
    onCancel: root.cancel()
    onOk: root.apply()
  }
}
