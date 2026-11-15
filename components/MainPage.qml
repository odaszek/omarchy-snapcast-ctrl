import QtQuick
import qs.Commons

// SnapWeb's server view: one card per group with a visible client.
Column {
  id: root
  property var app: null
  readonly property var service: app ? app.service : null
  spacing: Style.space(10)

  PlainText {
    width: parent.width
    visible: root.service && root.service.connected && root.service.groupIds.length === 0
    topPadding: Style.space(16)
    bottomPadding: Style.space(16)
    horizontalAlignment: Text.AlignHCenter
    text: root.app ? root.app.strings.t("main.empty") : ""
    color: root.app ? root.app.dim : "gray"
    font.family: root.app ? root.app.fontFamily : Style.font.family
    font.pixelSize: Style.font.body
  }

  Repeater {
    model: root.service ? root.service.groupIds : []

    GroupCard {
      required property string modelData
      width: root.width
      app: root.app
      groupId: modelData
    }
  }
}
