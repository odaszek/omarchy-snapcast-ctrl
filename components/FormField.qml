import QtQuick
import qs.Commons

// Caption above a control.
Column {
  id: root
  property var app: null
  property string label: ""
  property string hint: ""
  property string error: ""
  default property alias control: holder.data
  spacing: Style.space(4)

  PlainText {
    width: parent.width
    visible: root.label !== ""
    text: root.label
    color: root.app ? root.app.dim : "gray"
    font.family: root.app ? root.app.fontFamily : Style.font.family
    font.pixelSize: Style.font.caption
    font.bold: true
  }
  Item {
    id: holder
    width: parent.width
    implicitHeight: childrenRect.height
  }
  PlainText {
    width: parent.width
    visible: root.error !== "" || root.hint !== ""
    text: root.error !== "" ? root.error : root.hint
    wrapMode: Text.Wrap
    color: root.error !== "" ? (root.app ? root.app.urgent : "red") : (root.app ? root.app.dim : "gray")
    font.family: root.app ? root.app.fontFamily : Style.font.family
    font.pixelSize: Style.font.caption
  }
}
