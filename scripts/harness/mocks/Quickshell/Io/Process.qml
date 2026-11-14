import QtQuick
import "Fixture.mjs" as Fixture
// C-009 mock Process: never spawns anything. When running flips true it
// answers canned data through the attached StdioCollector (30 ms later, so
// async semantics hold), then reports exit 0. Every request logs a marker.
Item {
  id: proc
  property var command: []
  property bool running: false
  property bool stdinEnabled: false
  property string lastErr: ""
  property var stdout: null
  property var stderr: null
  property string reply: ""
  signal started()
  signal exited(int exitCode, int exitStatus)
  function scriptTail() { return String((command || [])[1] || "").split("/").pop() }
  function write(data) {
    // names the process so assertions can bind the message text to the SEND's
    // stdin, not to the spellchecker's (which also writes the compose text).
    console.error("MOCK stdin→" + scriptTail() + ": " + String(data))
  }
  onRunningChanged: {
    if (!running) return
    started()
    var argv = command || []
    var script = String(argv[1] || "")
    var tail = script.split("/").pop()
    console.error("MOCK process " + tail + " argv=" + JSON.stringify(argv.slice(2)))
    if (tail === "thread.ts") {
      reply = Fixture.threadOutput(argv[2])
    } else {
      reply = ""
    }
    respond.restart()
  }
  Timer {
    id: respond
    interval: 30
    onTriggered: {
      if (proc.stdout) { proc.stdout.text = proc.reply; proc.stdout.streamFinished() }
      if (proc.stderr) { proc.stderr.text = ""; proc.stderr.streamFinished() }
      proc.running = false
      proc.exited(0, 0)
    }
  }
}
