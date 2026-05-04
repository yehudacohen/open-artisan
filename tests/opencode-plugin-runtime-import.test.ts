import { describe, expect, it } from "bun:test"

describe("OpenCode plugin runtime import", () => {
  it("imports the real plugin module without the test shim", async () => {
    const proc = Bun.spawn({
      cmd: [
        process.execPath,
        "-e",
        "await import('./.opencode/plugins/open-artisan.ts'); console.log('ok')",
      ],
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        BUN_OPTIONS: "",
      },
    })

    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])

    expect(stderr).toBe("")
    expect(stdout.trim()).toBe("ok")
    expect(exitCode).toBe(0)
  })
})
