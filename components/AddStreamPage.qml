import QtQuick
import qs.Commons
import qs.Ui
import "../lib/model.mjs" as Model

// Stream.AddStream form. The URI is built and validated by
// Model.buildStreamUri (again in the helper), so fields can't inject extra
// parameters. Sources are created on the server host, not on this computer.
Column {
  id: root
  property var app: null
  readonly property var service: app ? app.service : null

  property string type: "pipe"
  property string name: ""
  property string path: "/tmp/snapfifo"
  property string mode: "create"
  property string host: ""
  property string port: "4953"
  property string device: "hw:0,1,0"
  property var sources: ({})
  property string codec: ""
  property string sampleformat: ""
  property string controlscript: ""
  property string devicename: ""
  property string bitrate: ""
  property string error: ""
  property string errorField: ""
  property bool busy: false

  spacing: Style.space(12)

  readonly property var spec: ({
    type: type, name: name, path: path, mode: mode, host: host, port: port, device: device,
    sources: Object.keys(sources).filter(function(k) { return sources[k] }),
    codec: codec, sampleformat: sampleformat, controlscript: controlscript, devicename: devicename, bitrate: bitrate
  })
  readonly property var preview: Model.buildStreamUri(spec)

  onTypeChanged: {
    error = ""
    if (type === "tcp") mode = "server"
    else if (type === "pipe") mode = "create"
    if (type === "librespot") path = "/usr/bin/librespot"
    else if (type === "airplay") path = "/usr/bin/shairport-sync"
    else if (type === "pipe") path = "/tmp/snapfifo"
    else if (type === "file") path = ""
  }

  function submit() {
    var built = Model.buildStreamUri(spec)
    if (!built.ok) {
      error = built.error
      errorField = built.field
      return
    }
    busy = true
    error = ""
    service.addStream(spec, function(ok, result) {
      root.busy = false
      if (!ok) {
        root.error = String(result)
        root.errorField = ""
        return
      }
      if (!result.added) {
        root.error = String(result.error || "")
        root.errorField = String(result.field || "")
        return
      }
      root.app.back()
    })
  }

  function fieldError(f) { return errorField === f ? error : "" }

  FormField {
    width: parent.width
    app: root.app
    label: root.app.strings.t("addStream.type")
    hint: root.app.strings.t("addStream.typeHint." + root.type)
    Dropdown {
      width: parent.width
      showLabel: false
      value: root.type
      options: Model.STREAM_TYPES.map(function(t) { return { value: t, label: root.app.strings.t("addStream.types." + t, t) } })
      foreground: root.app.fg
      background: root.app.panelBackground
      fontFamily: root.app.fontFamily
      onChanged: function(v) { root.type = v }
    }
  }

  FormField {
    width: parent.width
    app: root.app
    label: root.app.strings.t("addStream.name")
    error: root.fieldError("name")
    Field {
      app: root.app
      text: root.name
      maximumLength: 64
      placeholderText: root.app.strings.t("addStream.namePlaceholder")
      onTextChanged: root.name = text
    }
  }

  FormField {
    width: parent.width
    visible: root.type === "pipe" || root.type === "file" || root.type === "librespot" || root.type === "airplay"
    app: root.app
    label: root.type === "librespot" || root.type === "airplay" ? root.app.strings.t("addStream.program") : root.app.strings.t("addStream.path")
    hint: root.type === "pipe" ? root.app.strings.t("addStream.pathHintPipe") : ""
    error: root.fieldError("path")
    Field {
      app: root.app
      text: root.path
      maximumLength: 1024
      onTextChanged: root.path = text
    }
  }

  FormField {
    width: parent.width
    visible: root.type === "pipe" || root.type === "tcp"
    app: root.app
    label: root.app.strings.t("addStream.mode")
    error: root.fieldError("mode")
    ButtonGroup {
      width: parent.width
      options: root.type === "pipe"
        ? [{ value: "create", label: root.app.strings.t("addStream.modeCreate") }, { value: "read", label: root.app.strings.t("addStream.modeRead") }]
        : [{ value: "server", label: root.app.strings.t("addStream.modeServer") }, { value: "client", label: root.app.strings.t("addStream.modeClient") }]
      value: root.mode
      foreground: root.app.fg
      background: root.app.panelBackground
      fontFamily: root.app.fontFamily
      onChanged: function(v) { root.mode = v }
    }
  }

  Row {
    width: parent.width
    visible: root.type === "tcp"
    spacing: Style.space(8)
    FormField {
      width: parent.width * 0.68
      app: root.app
      label: root.mode === "server" ? root.app.strings.t("addStream.listenAddress") : root.app.strings.t("addStream.host")
      error: root.fieldError("host")
      Field {
        app: root.app
        text: root.host
        maximumLength: 253
        placeholderText: root.mode === "server" ? "0.0.0.0" : "192.168.0.10"
        onTextChanged: root.host = text
      }
    }
    FormField {
      width: parent.width * 0.32 - Style.space(8)
      app: root.app
      label: root.app.strings.t("addStream.port")
      error: root.fieldError("port")
      Field {
        app: root.app
        text: root.port
        maximumLength: 5
        inputMethodHints: Qt.ImhDigitsOnly
        onTextChanged: root.port = text
      }
    }
  }

  FormField {
    width: parent.width
    visible: root.type === "alsa"
    app: root.app
    label: root.app.strings.t("addStream.device")
    hint: root.app.strings.t("addStream.deviceHint")
    error: root.fieldError("device")
    Field {
      app: root.app
      text: root.device
      maximumLength: 128
      onTextChanged: root.device = text
    }
  }

  FormField {
    width: parent.width
    visible: root.type === "meta"
    app: root.app
    label: root.app.strings.t("addStream.sources")
    hint: root.app.strings.t("addStream.sourcesHint")
    error: root.fieldError("sources")
    Column {
      width: parent.width
      spacing: Style.space(4)
      Repeater {
        model: Model.metaSourceCandidates(root.service ? root.service.server : null)
        Toggle {
          required property string modelData
          width: root.width
          label: modelData
          checked: root.sources[modelData] === true
          foreground: root.app.fg
          fontFamily: root.app.fontFamily
          titleSize: Style.font.body
          onClicked: {
            var s = Object.assign({}, root.sources)
            if (s[modelData]) delete s[modelData]
            else s[modelData] = true
            root.sources = s
          }
        }
      }
    }
  }

  FormField {
    width: parent.width
    visible: root.type === "librespot" || root.type === "airplay"
    app: root.app
    label: root.app.strings.t("addStream.devicename")
    error: root.fieldError("devicename")
    Field {
      app: root.app
      text: root.devicename
      maximumLength: 64
      placeholderText: "Snapcast"
      onTextChanged: root.devicename = text
    }
  }

  FormField {
    width: parent.width
    visible: root.type === "librespot"
    app: root.app
    label: root.app.strings.t("addStream.bitrate")
    ButtonGroup {
      width: parent.width
      options: [{ value: "", label: root.app.strings.t("addStream.default") }, { value: "96", label: "96" }, { value: "160", label: "160" }, { value: "320", label: "320" }]
      value: root.bitrate
      foreground: root.app.fg
      background: root.app.panelBackground
      fontFamily: root.app.fontFamily
      onChanged: function(v) { root.bitrate = v }
    }
  }

  Row {
    width: parent.width
    spacing: Style.space(8)
    FormField {
      width: (parent.width - Style.space(8)) / 2
      app: root.app
      label: root.app.strings.t("addStream.codec")
      error: root.fieldError("codec")
      Dropdown {
        width: parent.width
        showLabel: false
        value: root.codec
        options: Model.CODECS.map(function(c) { return { value: c, label: c === "" ? root.app.strings.t("addStream.default") : c } })
        foreground: root.app.fg
        background: root.app.panelBackground
        fontFamily: root.app.fontFamily
        onChanged: function(v) { root.codec = v }
      }
    }
    FormField {
      width: (parent.width - Style.space(8)) / 2
      app: root.app
      label: root.app.strings.t("addStream.sampleformat")
      error: root.fieldError("sampleformat")
      Field {
        app: root.app
        text: root.sampleformat
        maximumLength: 16
        placeholderText: "48000:16:2"
        onTextChanged: root.sampleformat = text
      }
    }
  }

  FormField {
    width: parent.width
    app: root.app
    label: root.app.strings.t("addStream.controlscript")
    hint: root.app.strings.t("addStream.controlscriptHint")
    error: root.fieldError("controlscript")
    Field {
      app: root.app
      text: root.controlscript
      maximumLength: 64
      placeholderText: "meta_mpd.py"
      onTextChanged: root.controlscript = text
    }
  }

  FormField {
    width: parent.width
    app: root.app
    label: root.app.strings.t("addStream.uri")
    PlainText {
      width: parent.width
      text: root.preview.ok ? root.preview.uri : "—"
      wrapMode: Text.WrapAnywhere
      elide: Text.ElideNone
      color: root.app.dim
      font.family: root.app.fontFamily
      font.pixelSize: Style.font.caption
    }
  }

  PlainText {
    width: parent.width
    visible: root.error !== "" && root.errorField === ""
    text: root.error
    wrapMode: Text.Wrap
    color: root.app.urgent
    font.family: root.app.fontFamily
    font.pixelSize: Style.font.bodySmall
  }

  ActionRow {
    width: parent.width
    app: root.app
    okText: root.app.strings.t("addStream.submit")
    busy: root.busy
    okEnabled: root.service && root.service.connected
    onCancel: root.app.back()
    onOk: root.submit()
  }
}
