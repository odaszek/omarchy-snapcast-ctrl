import QtQuick
import qs.Commons
import qs.Ui

// Themed text input that tells the panel while it has focus, so the panel's
// key handling (Esc = back, letters = shortcuts) leaves typing alone.
TextField {
  id: root
  property var app: null
  width: parent ? parent.width : implicitWidth
  font.family: app ? app.fontFamily : Style.font.family
  font.pixelSize: Style.font.body
  foreground: app ? app.fg : "white"
  horizontalPadding: Style.spacing.controlGap
  verticalPadding: Style.spacing.controlPaddingY
  selectByMouse: true
  onActiveFocusChanged: if (app) app.editing = activeFocus
  Keys.onEscapePressed: function(event) {
    root.focus = false
    if (root.app) root.app.editing = false
    event.accepted = true
  }
}
