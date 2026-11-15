import QtQuick
import QtTest
import "../../components"
import "../../lib/model.mjs" as Model

// qmltestrunner -input tests/qml
// Markup-shaped server strings must render literally.
Item {
  width: 800
  height: 200

  PlainText { id: plain; font.pixelSize: 14 }
  Text { id: auto; font.pixelSize: 14; textFormat: Text.AutoText }
  Text { id: literal; font.pixelSize: 14; textFormat: Text.PlainText }

  TestCase {
    name: "PlainText"
    when: windowShown

    function test_plainTextFormat() {
      compare(plain.textFormat, Text.PlainText)
    }

    function test_markupIsLiteral_data() {
      return [
        { tag: "img", s: "<img src=\"http://127.0.0.1:9/x.png\">" },
        { tag: "bold", s: "<b>bold</b> name" },
        { tag: "link", s: "<a href=\"http://evil\">click</a>" },
        { tag: "entity", s: "&lt;x&gt; &amp;" }
      ]
    }

    function test_markupIsLiteral(data) {
      plain.text = data.s
      literal.text = data.s
      compare(plain.implicitWidth, literal.implicitWidth)
    }

    // Omarchy's own components may use AutoText; Model.neutralize must stop
    // tag detection without changing what is shown.
    function test_neutralizeDefeatsAutoText_data() {
      return [
        { tag: "img", s: "<img src=\"http://127.0.0.1:9/x.png\">" },
        { tag: "bold", s: "<b>bold</b>" },
        { tag: "font", s: "<font color=red>x</font>" }
      ]
    }

    function test_neutralizeDefeatsAutoText(data) {
      var n = Model.neutralize(data.s)
      auto.text = n
      literal.text = n
      compare(auto.implicitWidth, literal.implicitWidth, "AutoText rendered the neutralized string literally")
      // And without neutralize, AutoText would have interpreted it (sanity check of the test itself).
      auto.text = data.s
      literal.text = data.s
      verify(auto.implicitWidth < literal.implicitWidth, "un-neutralized markup is interpreted by AutoText")
    }
  }
}
