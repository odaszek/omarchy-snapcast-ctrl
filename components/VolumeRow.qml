import QtQuick
import qs.Commons
import qs.Commons as Commons
import qs.Ui
import "../lib/model.mjs" as Model

// [mute] ──────── slider ──────── 42%
Item {
  id: root
  property var app: null
  property bool muted: false
  property real value: 0
  property bool enabled_: true
  property string muteTooltip: ""
  readonly property bool dragging: slider.dragging

  signal muteToggled()
  signal moved(real value)
  signal dragStarted()
  signal released(real value)

  implicitHeight: Math.max(muteButton.implicitHeight, slider.implicitHeight)

  IconButton {
    id: muteButton
    app: root.app
    anchors.left: parent.left
    anchors.verticalCenter: parent.verticalCenter
    enabled: root.enabled_
    iconText: root.muted ? Model.ICON.muted : Model.ICON.volume
    hoverColor: root.app ? root.app.accent : "white"
    tooltipText: root.muteTooltip
    onClicked: root.muteToggled()
  }

  PanelSlider {
    id: slider
    bar: root.app ? root.app.bar : null
    anchors.left: muteButton.right
    anchors.leftMargin: Style.space(6)
    anchors.right: percent.left
    anchors.rightMargin: Style.space(6)
    anchors.verticalCenter: parent.verticalCenter
    enabled: root.enabled_
    minimum: 0
    maximum: 100
    step: 5
    integer: true
    value: root.value
    opacity: root.muted ? 0.45 : 1
    onDraggingChanged: if (dragging) root.dragStarted()
    onMoved: function(v) { root.moved(v) }
    onReleased: function(v) { root.released(v) }
    onRightClicked: root.muteToggled()
  }

  PlainText {
    id: percent
    anchors.right: parent.right
    anchors.verticalCenter: parent.verticalCenter
    width: Style.space(38)
    horizontalAlignment: Text.AlignRight
    text: Commons.I18n.formatNumber(Math.round(slider.dragging ? slider.liveValue : root.value)) + "%"
    color: root.app ? root.app.dim : "gray"
    font.family: root.app ? root.app.fontFamily : Style.font.family
    font.pixelSize: Style.font.caption
    font.bold: true
  }
}
