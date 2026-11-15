import QtQuick
import qs.Commons
import qs.Ui

// Glyph button themed from the panel (`app`).
PanelActionButton {
  property var app: null
  foreground: app ? app.fg : "white"
  fontFamily: app ? app.fontFamily : Style.font.family
  opacity: enabled ? 1 : 0.35
}
