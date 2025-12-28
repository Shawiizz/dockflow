"use client"

import { useEffect, useState, useRef } from "react"

interface TerminalLine {
  type: 'command' | 'output' | 'success' | 'info' | 'progress'
  text: string
  delay: number
}

const terminalSequence: TerminalLine[] = [
  { type: 'command', text: '$ dockflow deploy', delay: 0 },
  { type: 'info', text: '', delay: 800 },
  { type: 'info', text: '  Dockflow v1.0.0 - Deploy with confidence', delay: 100 },
  { type: 'info', text: '', delay: 100 },
  { type: 'output', text: '▸ Connecting to server 192.168.1.100...', delay: 400 },
  { type: 'success', text: '  ✓ Connected via SSH', delay: 600 },
  { type: 'info', text: '', delay: 200 },
  { type: 'output', text: '▸ Building Docker image...', delay: 400 },
  { type: 'progress', text: '  [████████████████████████████████████████] 100%', delay: 1500 },
  { type: 'success', text: '  ✓ Image built: myapp:v2.1.0', delay: 300 },
  { type: 'info', text: '', delay: 200 },
  { type: 'output', text: '▸ Pushing image to registry...', delay: 400 },
  { type: 'success', text: '  ✓ Image pushed successfully', delay: 800 },
  { type: 'info', text: '', delay: 200 },
  { type: 'output', text: '▸ Deploying to Docker Swarm...', delay: 400 },
  { type: 'output', text: '  → Updating service myapp_web', delay: 500 },
  { type: 'output', text: '  → Rolling update in progress...', delay: 600 },
  { type: 'success', text: '  ✓ Service updated (3/3 replicas)', delay: 800 },
  { type: 'info', text: '', delay: 200 },
  { type: 'output', text: '▸ Running health checks...', delay: 400 },
  { type: 'success', text: '  ✓ All containers healthy', delay: 700 },
  { type: 'info', text: '', delay: 300 },
  { type: 'success', text: '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', delay: 200 },
  { type: 'success', text: '✓ Deployment completed successfully in 12.4s', delay: 100 },
  { type: 'success', text: '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', delay: 100 },
  { type: 'info', text: '', delay: 300 },
  { type: 'output', text: '  App URL: https://myapp.example.com', delay: 200 },
]

export function TerminalDemo() {
  const [lines, setLines] = useState<TerminalLine[]>([])
  const [isRunning, setIsRunning] = useState(false)
  const [hasRun, setHasRun] = useState(false)
  const terminalRef = useRef<HTMLDivElement>(null)

  const runDemo = async () => {
    if (isRunning) return
    setIsRunning(true)
    setLines([])
    setHasRun(true)

    let totalDelay = 0
    for (const line of terminalSequence) {
      totalDelay += line.delay
      setTimeout(() => {
        setLines(prev => [...prev, line])
        if (terminalRef.current) {
          terminalRef.current.scrollTop = terminalRef.current.scrollHeight
        }
      }, totalDelay)
    }

    setTimeout(() => {
      setIsRunning(false)
    }, totalDelay + 500)
  }

  useEffect(() => {
    // Auto-run on mount
    const timer = setTimeout(() => {
      runDemo()
    }, 1000)
    return () => clearTimeout(timer)
  }, [])

  const getLineClass = (type: string) => {
    switch (type) {
      case 'command': return 'terminal-command'
      case 'success': return 'terminal-success'
      case 'info': return 'terminal-info'
      case 'progress': return 'terminal-progress'
      default: return 'terminal-output'
    }
  }

  return (
    <div className="terminal-section">
      <div className="terminal-window">
        <div className="terminal-header">
          <div className="terminal-buttons">
            <span className="terminal-btn terminal-btn-red"></span>
            <span className="terminal-btn terminal-btn-yellow"></span>
            <span className="terminal-btn terminal-btn-green"></span>
          </div>
          <span className="terminal-title">Terminal</span>
          <button 
            className="terminal-replay"
            onClick={runDemo}
            disabled={isRunning}
          >
            {isRunning ? 'Running...' : 'Replay'}
          </button>
        </div>
        <div className="terminal-body" ref={terminalRef}>
          {lines.map((line, index) => (
            <div key={index} className={`terminal-line ${getLineClass(line.type)}`}>
              {line.text || '\u00A0'}
            </div>
          ))}
          {isRunning && (
            <div className="terminal-cursor">▋</div>
          )}
          {!hasRun && (
            <div className="terminal-line terminal-info">
              Click "Replay" or wait to see Dockflow in action...
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
