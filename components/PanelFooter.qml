import QtQuick
import qs.Commons

// Last warning from the helper (failed request, server error); fades out after a while.
Item {
  id: root
  property var app: null
  readonly property var service: app ? app.service : null
  implicitHeight: label.text !== "" ? label.implicitHeight : 0
  visible: implicitHeight > 0

  PlainText {
    id: label
    width: parent.width
    horizontalAlignment: Text.AlignHCenter
    text: root.service ? root.service.lastWarning : ""
    color: root.app ? root.app.dim : "gray"
    font.family: root.app ? root.app.fontFamily : Style.font.family
    font.pixelSize: Style.font.caption
  }
}
