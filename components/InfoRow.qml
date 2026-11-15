import QtQuick
import qs.Commons

// Read-only "label    value" line.
Item {
  id: root
  property var app: null
  property string label: ""
  property string value: ""
  implicitHeight: Math.max(l.implicitHeight, v.implicitHeight)
  visible: value !== ""

  PlainText {
    id: l
    anchors.left: parent.left
    width: Math.min(implicitWidth, parent.width * 0.35)
    text: root.label
    color: root.app ? root.app.dim : "gray"
    font.family: root.app ? root.app.fontFamily : Style.font.family
    font.pixelSize: Style.font.bodySmall
  }
  PlainText {
    id: v
    anchors.left: l.right
    anchors.leftMargin: Style.space(12)
    anchors.right: parent.right
    horizontalAlignment: Text.AlignRight
    text: root.value
    color: root.app ? root.app.fg : "white"
    font.family: root.app ? root.app.fontFamily : Style.font.family
    font.pixelSize: Style.font.bodySmall
  }
}
