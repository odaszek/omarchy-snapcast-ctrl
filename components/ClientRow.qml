import QtQuick
import qs.Commons
import qs.Ui
import "../lib/model.mjs" as Model

// A client in a group card (SnapWeb Client): name, mute + volume, menu → details.
// Offline clients are dimmed.
Item {
  id: root
  property var app: null
  property string clientId: ""
  readonly property var service: app ? app.service : null
  readonly property var client: service ? Model.findClient(service.server, clientId) : null
  readonly property bool isLocal: service && service.localClientId !== "" && clientId === service.localClientId

  opacity: client && client.connected ? 1 : 0.5
  implicitHeight: col.implicitHeight

  Column {
    id: col
    anchors.left: parent.left
    anchors.right: menuButton.left
    anchors.rightMargin: Style.space(4)
    spacing: Style.space(2)

    Row {
      width: parent.width
      spacing: Style.space(6)
      PlainText {
        visible: root.isLocal
        text: Model.ICON.laptop
        color: root.app.accent
        font.family: root.app.fontFamily
        font.pixelSize: Style.font.body
      }
      PlainText {
        width: parent.width - (root.isLocal ? Style.space(24) : 0)
        text: Model.clientName(root.client) + (root.isLocal ? " · " + root.app.strings.t("client.thisDevice") : "")
        color: root.app.fg
        font.family: root.app.fontFamily
        font.pixelSize: Style.font.body
      }
    }

    VolumeRow {
      width: parent.width
      app: root.app
      muted: root.client ? root.client.config.volume.muted : false
      value: root.client ? root.client.config.volume.percent : 0
      muteTooltip: root.app.strings.t("client.mute")
      onMuteToggled: root.service.setClientMuted(root.clientId, !root.client.config.volume.muted)
      onMoved: function(v) { root.service.setClientVolume(root.clientId, v) }
    }
  }

  IconButton {
    id: menuButton
    app: root.app
    anchors.right: parent.right
    anchors.verticalCenter: parent.verticalCenter
    iconText: Model.ICON.more
    tooltipText: root.app.strings.t("client.details")
    onClicked: root.app.go("client", root.clientId)
  }
}
