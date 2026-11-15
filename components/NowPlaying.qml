import QtQuick
import qs.Commons
import "../lib/model.mjs" as Model

// Cover art + title / artist. The art is a local file the helper downloaded
// and checked (helper/art.ts); remote URLs never reach this Image.
Item {
  id: root
  property var app: null
  property var stream: null
  readonly property var meta: stream && stream.properties.metadata ? stream.properties.metadata : null
  readonly property string artFile: stream && stream.artFile ? stream.artFile : ""
  readonly property int artSize: Style.space(48)

  implicitHeight: Math.max(artSize, labels.implicitHeight)

  Rectangle {
    id: artBox
    width: root.artSize
    height: root.artSize
    anchors.left: parent.left
    anchors.verticalCenter: parent.verticalCenter
    radius: Math.min(Style.cornerRadius, Style.space(6))
    color: root.app ? root.app.subtle : "transparent"
    clip: true

    Image {
      id: art
      anchors.fill: parent
      visible: status === Image.Ready
      source: root.artFile !== "" ? "file://" + root.artFile : ""
      sourceSize.width: root.artSize * 2
      sourceSize.height: root.artSize * 2
      fillMode: Image.PreserveAspectCrop
      asynchronous: true
      cache: false
      smooth: true
    }

    PlainText {
      anchors.centerIn: parent
      visible: !art.visible
      text: Model.ICON.music
      color: root.app ? root.app.dim : "gray"
      font.family: root.app ? root.app.fontFamily : Style.font.family
      font.pixelSize: Style.font.icon * 1.4
    }
  }

  Column {
    id: labels
    anchors.left: artBox.right
    anchors.leftMargin: Style.space(10)
    anchors.right: parent.right
    anchors.verticalCenter: parent.verticalCenter
    spacing: Style.space(2)

    PlainText {
      width: parent.width
      text: root.meta && root.meta.title !== "" ? root.meta.title : (root.app ? root.app.strings.t("meta.unknownTitle") : "")
      color: root.app ? root.app.fg : "white"
      font.family: root.app ? root.app.fontFamily : Style.font.family
      font.pixelSize: Style.font.body
      font.bold: true
    }
    PlainText {
      width: parent.width
      text: Model.artistLine(root.meta) !== "" ? Model.artistLine(root.meta) : (root.app ? root.app.strings.t("meta.unknownArtist") : "")
      color: root.app ? root.app.dim : "gray"
      font.family: root.app ? root.app.fontFamily : Style.font.family
      font.pixelSize: Style.font.bodySmall
    }
    PlainText {
      width: parent.width
      visible: text !== ""
      text: root.meta ? root.meta.album : ""
      color: root.app ? root.app.dim : "gray"
      font.family: root.app ? root.app.fontFamily : Style.font.family
      font.pixelSize: Style.font.caption
    }
  }
}
