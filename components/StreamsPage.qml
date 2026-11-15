import QtQuick
import qs.Commons
import qs.Ui
import "../lib/model.mjs" as Model

// Streams on the server: status, source URI, which groups play it, Remove,
// and Add stream.
Column {
  id: root
  property var app: null
  readonly property var service: app ? app.service : null
  readonly property var streams: service ? service.server.streams : []
  spacing: Style.space(10)

  function groupsOf(streamId) {
    var out = []
    var groups = service ? service.server.groups : []
    for (var i = 0; i < groups.length; i++) if (groups[i].stream_id === streamId) out.push(Model.groupName(groups[i]))
    return out.join(", ")
  }

  Button {
    text: root.app.strings.t("streams.add")
    iconText: Model.ICON.add
    focusable: true
    bordered: true
    enabled: root.service && root.service.connected
    foreground: root.app.fg
    fontFamily: root.app.fontFamily
    onClicked: root.app.go("addStream")
  }

  PlainText {
    width: parent.width
    visible: root.streams.length === 0
    text: root.app.strings.t("streams.empty")
    color: root.app.dim
    font.family: root.app.fontFamily
    font.pixelSize: Style.font.body
  }

  Repeater {
    model: root.streams

    Rectangle {
      required property var modelData
      width: root.width
      radius: Style.cornerRadius
      color: root.app.subtle
      implicitHeight: col.implicitHeight + Style.space(16)

      Column {
        id: col
        anchors.left: parent.left
        anchors.right: removeButton.left
        anchors.top: parent.top
        anchors.margins: Style.space(8)
        spacing: Style.space(2)

        PlainText {
          width: parent.width
          text: modelData.id
          color: root.app.fg
          font.family: root.app.fontFamily
          font.pixelSize: Style.font.body
          font.bold: true
        }
        PlainText {
          width: parent.width
          text: root.app.strings.t("stream.status." + modelData.status, modelData.status) + " · " + modelData.uri.scheme
            + (modelData.uri.query.codec ? " · " + modelData.uri.query.codec : "")
            + (modelData.uri.query.sampleformat ? " · " + modelData.uri.query.sampleformat : "")
          color: modelData.status === "playing" ? root.app.accent : root.app.dim
          font.family: root.app.fontFamily
          font.pixelSize: Style.font.caption
        }
        PlainText {
          width: parent.width
          text: modelData.uri.raw
          color: root.app.dim
          font.family: root.app.fontFamily
          font.pixelSize: Style.font.caption
          elide: Text.ElideMiddle
        }
        PlainText {
          width: parent.width
          visible: text !== ""
          text: root.groupsOf(modelData.id) !== "" ? root.app.strings.t("streams.playingIn").arg(root.groupsOf(modelData.id)) : ""
          color: root.app.dim
          font.family: root.app.fontFamily
          font.pixelSize: Style.font.caption
        }
      }

      IconButton {
        id: removeButton
        app: root.app
        anchors.right: parent.right
        anchors.rightMargin: Style.space(6)
        anchors.verticalCenter: parent.verticalCenter
        iconText: Model.ICON.remove
        hoverColor: root.app.urgent
        tooltipText: root.app.strings.t("streams.remove")
        onClicked: root.app.confirm(root.app.strings.t("streams.removeConfirm").arg(Model.neutralize(modelData.id)),
          root.app.strings.t("streams.remove"), function() { root.service.removeStream(modelData.id) })
      }
    }
  }
}
