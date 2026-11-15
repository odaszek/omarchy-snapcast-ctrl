import QtQuick

// Every text element in this plugin goes through here. Names, stream ids and
// metadata come from the Snapcast server and are untrusted: Text.AutoText
// would render markup such as <img src="https://…"> as rich text and load
// remote resources.
Text {
  textFormat: Text.PlainText
  elide: Text.ElideRight
}
