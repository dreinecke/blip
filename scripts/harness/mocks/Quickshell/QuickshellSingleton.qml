pragma Singleton
import QtQuick
// C-009 mock: the three Quickshell globals the view's closure uses.
// env returns the scratch HOME (patched to the build root by build.py) so
// ~/ expansion stays inside the harness.
QtObject {
  function env(name) { return name === "HOME" ? "__HARNESS_HOME__" : "" }
  function execDetached(argv) {
    console.error("MOCK execDetached " + JSON.stringify(argv))
    return true
  }
}
