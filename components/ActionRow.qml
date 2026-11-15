import QtQuick
import qs.Commons
import qs.Ui

// Cancel / OK buttons at the bottom of a page (SnapWeb dialog actions).
Item {
  id: root
  property var app: null
  property string okText: app ? app.strings.t("common.ok") : "OK"
  property string cancelText: app ? app.strings.t("common.cancel") : "Cancel"
  property bool okEnabled: true
  property bool busy: false
  signal ok()
  signal cancel()
  implicitHeight: okButton.implicitHeight

  Row {
    anchors.right: parent.right
    spacing: Style.space(8)
    Button {
      text: root.cancelText
      focusable: true
      foreground: root.app ? root.app.fg : "white"
      fontFamily: root.app ? root.app.fontFamily : Style.font.family
      onClicked: root.cancel()
    }
    Button {
      id: okButton
      text: root.okText
      focusable: true
      bordered: true
      enabled: root.okEnabled && !root.busy
      opacity: enabled ? 1 : 0.5
      iconSpinning: root.busy
      foreground: root.app ? root.app.accent : "white"
      fontFamily: root.app ? root.app.fontFamily : Style.font.family
      onClicked: root.ok()
    }
  }
}
