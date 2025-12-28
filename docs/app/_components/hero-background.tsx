"use client"

import { useEffect, useRef } from "react"
import * as THREE from "three"

export function HeroBackground() {
  const containerRef = useRef<HTMLDivElement>(null)
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null)
  const frameRef = useRef<number>(0)

  useEffect(() => {
    if (!containerRef.current) return

    const container = containerRef.current
    const width = container.clientWidth
    const height = container.clientHeight

    // Scene setup
    const scene = new THREE.Scene()

    // Orthographic camera for 2D effect
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)

    // Renderer setup
    const renderer = new THREE.WebGLRenderer({ 
      alpha: true, 
      antialias: true,
      powerPreference: "high-performance"
    })
    renderer.setSize(width, height)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setClearColor(0x000000, 0)
    container.appendChild(renderer.domElement)
    rendererRef.current = renderer

    // Shader material for smooth animated gradient
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uResolution: { value: new THREE.Vector2(width, height) }
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform float uTime;
        uniform vec2 uResolution;
        varying vec2 vUv;
        
        // Simplex noise function
        vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
        vec2 mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
        vec3 permute(vec3 x) { return mod289(((x*34.0)+1.0)*x); }
        
        float snoise(vec2 v) {
          const vec4 C = vec4(0.211324865405187, 0.366025403784439,
                             -0.577350269189626, 0.024390243902439);
          vec2 i  = floor(v + dot(v, C.yy));
          vec2 x0 = v -   i + dot(i, C.xx);
          vec2 i1;
          i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
          vec4 x12 = x0.xyxy + C.xxzz;
          x12.xy -= i1;
          i = mod289(i);
          vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0))
            + i.x + vec3(0.0, i1.x, 1.0));
          vec3 m = max(0.5 - vec3(dot(x0,x0), dot(x12.xy,x12.xy),
            dot(x12.zw,x12.zw)), 0.0);
          m = m*m;
          m = m*m;
          vec3 x = 2.0 * fract(p * C.www) - 1.0;
          vec3 h = abs(x) - 0.5;
          vec3 ox = floor(x + 0.5);
          vec3 a0 = x - ox;
          m *= 1.79284291400159 - 0.85373472095314 * (a0*a0 + h*h);
          vec3 g;
          g.x  = a0.x  * x0.x  + h.x  * x0.y;
          g.yz = a0.yz * x12.xz + h.yz * x12.yw;
          return 130.0 * dot(m, g);
        }
        
        void main() {
          vec2 uv = vUv;
          float aspect = uResolution.x / uResolution.y;
          uv.x *= aspect;
          
          // Create diagonal streaks
          float angle = -0.6;
          vec2 rotatedUv = vec2(
            uv.x * cos(angle) - uv.y * sin(angle),
            uv.x * sin(angle) + uv.y * cos(angle)
          );
          
          // Multiple layers of noise for organic look
          float noise1 = snoise(rotatedUv * 1.5 + vec2(uTime * 0.05, 0.0));
          float noise2 = snoise(rotatedUv * 2.5 + vec2(uTime * 0.08, 0.5));
          float noise3 = snoise(rotatedUv * 0.8 + vec2(uTime * 0.03, 1.0));
          
          // Combine noises for streak pattern
          float streak = noise1 * 0.5 + noise2 * 0.3 + noise3 * 0.2;
          
          // Create diagonal gradient mask
          float diagonalGradient = (rotatedUv.x + rotatedUv.y) * 0.5 + 0.5;
          diagonalGradient = smoothstep(0.2, 0.8, diagonalGradient);
          
          // Threshold for visible areas
          float mask = smoothstep(0.1, 0.6, streak + diagonalGradient * 0.3);
          
          // Color gradient from dark red to bright red
          vec3 color1 = vec3(0.6, 0.05, 0.05);  // Dark red
          vec3 color2 = vec3(0.9, 0.15, 0.1);   // Bright red
          vec3 color3 = vec3(0.95, 0.3, 0.15);  // Orange-red
          
          float colorMix = streak * 0.5 + 0.5;
          vec3 color = mix(color1, color2, colorMix);
          color = mix(color, color3, smoothstep(0.6, 0.9, colorMix));
          
          // Fade out edges
          float edgeFade = smoothstep(0.0, 0.3, vUv.x) * smoothstep(1.0, 0.7, vUv.x);
          edgeFade *= smoothstep(0.0, 0.4, vUv.y) * smoothstep(1.0, 0.5, vUv.y);
          
          // Final alpha with subtle visibility
          float alpha = mask * edgeFade * 0.35;
          
          gl_FragColor = vec4(color, alpha);
        }
      `,
      transparent: true,
      depthWrite: false
    })

    // Full screen quad
    const geometry = new THREE.PlaneGeometry(2, 2)
    const mesh = new THREE.Mesh(geometry, material)
    scene.add(mesh)

    // Animation loop
    let startTime = Date.now()
    const animate = () => {
      frameRef.current = requestAnimationFrame(animate)
      const elapsed = (Date.now() - startTime) / 1000
      material.uniforms.uTime.value = elapsed
      renderer.render(scene, camera)
    }
    animate()

    // Handle resize
    const handleResize = () => {
      if (!containerRef.current || !rendererRef.current) return
      
      const w = containerRef.current.clientWidth
      const h = containerRef.current.clientHeight
      
      material.uniforms.uResolution.value.set(w, h)
      rendererRef.current.setSize(w, h)
    }
    window.addEventListener("resize", handleResize)

    // Cleanup
    return () => {
      window.removeEventListener("resize", handleResize)
      cancelAnimationFrame(frameRef.current)
      geometry.dispose()
      material.dispose()
      if (rendererRef.current && container) {
        container.removeChild(rendererRef.current.domElement)
        rendererRef.current.dispose()
      }
    }
  }, [])

  return (
    <div 
      ref={containerRef} 
      className="hero-background"
      aria-hidden="true"
    />
  )
}
