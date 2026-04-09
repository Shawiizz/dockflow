"use client"

import { useEffect, useState, useRef } from "react"

interface Line {
  text: string
  color: string
  bold?: boolean
}

const sequence: Line[] = [
  { text: "$ dockflow deploy production", color: "text-neutral-200", bold: true },
  { text: "\u00A0", color: "text-transparent" },
  { text: "◆  Loaded secrets from DOCKFLOW_SECRETS", color: "text-blue-400" },
  { text: "┌  Deploying App + Accessories (auto) to production", color: "text-neutral-200", bold: true },
  { text: "│", color: "text-neutral-700" },
  { text: "●  Version: v1.4.0", color: "text-neutral-400" },
  { text: "│", color: "text-neutral-700" },
  { text: "●  Environment: production", color: "text-neutral-400" },
  { text: "│", color: "text-neutral-700" },
  { text: "●  Manager: main_server (10.0.1.50)", color: "text-neutral-400" },
  { text: "│", color: "text-neutral-700" },
  { text: "◇  Building myapp-production:v1.4.0", color: "text-neutral-500" },
  { text: "│", color: "text-neutral-700" },
  { text: "◆  Built myapp-production:v1.4.0", color: "text-green-400" },
  { text: "│", color: "text-neutral-700" },
  { text: "◆  Transferred myapp-production:v1.4.0 to manager", color: "text-green-400" },
  { text: "◇  Distributed 1 image(s) to 1 node(s) [1m 53s]", color: "text-green-400" },
  { text: "│", color: "text-neutral-700" },
  { text: "◇  All services converged: myapp-production_app 1/1 [0s]", color: "text-green-400" },
  { text: "│", color: "text-neutral-700" },
  { text: "◇  All services healthy: myapp-production_app [3s]", color: "text-green-400" },
  { text: "│", color: "text-neutral-700" },
  { text: "◆  Deployment completed!", color: "text-green-400", bold: true },
]

export function Terminal() {
  const [visible, setVisible] = useState(0)
  const [running, setRunning] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const run = () => {
    if (running) return
    setRunning(true)
    setVisible(0)
    let i = 0
    const tick = () => {
      i++
      setVisible(i)
      if (ref.current) ref.current.scrollTop = ref.current.scrollHeight
      if (i < sequence.length) {
        const delay = sequence[i]?.color === "text-transparent" ? 250 : sequence[i]?.bold ? 600 : 100
        setTimeout(tick, delay)
      } else {
        setTimeout(() => setRunning(false), 400)
      }
    }
    setTimeout(tick, 600)
  }

  useEffect(() => {
    const t = setTimeout(run, 800)
    return () => clearTimeout(t)
  }, [])

  return (
    <div className="w-full rounded-xl overflow-hidden border border-neutral-200 dark:border-neutral-800">
      <div className="flex items-center px-4 py-2.5 bg-neutral-900 border-b border-neutral-800">
        <span className="w-2.5 h-2.5 rounded-full bg-red-500 mr-1.5" />
        <span className="w-2.5 h-2.5 rounded-full bg-yellow-500 mr-1.5" />
        <span className="w-2.5 h-2.5 rounded-full bg-green-500 mr-1.5" />
        <span className="flex-1 text-center text-xs text-neutral-600">Terminal</span>
        <button
          onClick={run}
          disabled={running}
          className="text-[11px] px-2.5 py-[3px] rounded-md bg-neutral-800 text-neutral-400 border-none cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {running ? "..." : "Replay"}
        </button>
      </div>
      <div
        ref={ref}
        className="bg-neutral-950 p-4 min-h-[300px] max-h-[360px] overflow-y-auto font-mono text-[13px] leading-relaxed"
      >
        {sequence.slice(0, visible).map((l, i) => (
          <div key={i} className={`whitespace-pre ${l.color} ${l.bold ? "font-semibold" : "font-normal"}`}>
            {l.text}
          </div>
        ))}
        {running && <span className="text-neutral-200">▋</span>}
      </div>
    </div>
  )
}
