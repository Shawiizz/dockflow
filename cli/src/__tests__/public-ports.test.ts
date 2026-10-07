import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  closedPorts,
  currentPublicPorts,
  describePublished,
  describeRule,
  publicPortRules,
  publishedPorts,
  recordCommand,
  ruleSpec,
  type PortRule,
} from '../services/public-ports';
import { parsePortSpec } from '../utils/port-spec';
import { loadFromString } from '../services/compose';
import { resolveLocalBash } from '../services/hook';
import type { ProxyConfig } from '../utils/config';

const anyone = (from: number, to = from, protocol: 'tcp' | 'udp' = 'tcp'): PortRule => ({ from, to, protocol, sources: [] });

describe('parsePortSpec', () => {
  it('reads a port or a range, TCP when unsaid', () => {
    expect(parsePortSpec(443)).toEqual({ from: 443, to: 443, protocol: 'tcp' });
    expect(parsePortSpec('51820/udp')).toEqual({ from: 51820, to: 51820, protocol: 'udp' });
    expect(parsePortSpec(' 8000-8010/TCP ')).toEqual({ from: 8000, to: 8010, protocol: 'tcp' });
  });

  it('refuses what is not a port of 1-65535', () => {
    for (const value of ['0', '65536', '10-5', 'http', '443/sctp', '', '1.5', '-1']) {
      expect({ value, range: parsePortSpec(value) }).toEqual({ value, range: null });
    }
  });
});

describe('publicPortRules', () => {
  const firewall = { public_ports: [1883, '51820/udp', { port: '443/tcp', from: ['173.245.48.0/20'] }] };

  it('reads every form of firewall.public_ports', () => {
    expect(publicPortRules({ firewall })).toEqual([
      anyone(1883),
      anyone(51820, 51820, 'udp'),
      { from: 443, to: 443, protocol: 'tcp', sources: ['173.245.48.0/20'] },
    ]);
  });

  it("adds Traefik's ports when the proxy is on, 443 only with ACME", () => {
    expect(publicPortRules({ proxy: { enabled: true } as ProxyConfig })).toEqual([anyone(80), anyone(443)]);
    expect(publicPortRules({ proxy: { enabled: true, acme: false } as ProxyConfig })).toEqual([anyone(80)]);
    expect(publicPortRules({ proxy: { enabled: false } as ProxyConfig })).toEqual([]);
  });

  it("lets the project's own declaration of a Traefik port win, to keep it to a CDN", () => {
    const rules = publicPortRules({ firewall, proxy: { enabled: true } as ProxyConfig });
    expect(rules.filter((rule) => rule.from === 443)).toEqual([{ from: 443, to: 443, protocol: 'tcp', sources: ['173.245.48.0/20'] }]);
    expect(rules).toContainEqual(anyone(80));
    expect(publicPortRules({ firewall: { public_ports: ['1-1024'] }, proxy: { enabled: true } as ProxyConfig })).toEqual([anyone(1, 1024)]);
  });
});

describe('ruleSpec / describeRule', () => {
  it('writes a rule as the script takes it and as people read it', () => {
    const cdn: PortRule = { from: 443, to: 443, protocol: 'tcp', sources: ['173.245.48.0/20', '2400:cb00::/32'] };
    expect(ruleSpec(cdn)).toBe('443/tcp@173.245.48.0/20,2400:cb00::/32');
    expect(ruleSpec(anyone(8000, 8010, 'udp'))).toBe('8000-8010/udp');
    expect(describeRule(cdn)).toBe('443/tcp (from 2 addresses)');
    expect(describeRule({ ...cdn, sources: ['173.245.48.0/20'] })).toBe('443/tcp (from 1 address)');
    expect(describeRule(anyone(80))).toBe('80/tcp');
  });
});

describe('publishedPorts / closedPorts', () => {
  const compose = loadFromString(`
services:
  web:
    image: web
    ports:
      - "8080:80"
      - "8443:443/udp"
      - "3000"
      - "127.0.0.1:9000:9000"
      - "8000-8010:8000-8010"
  db:
    image: postgres
    ports:
      - target: 5432
        published: 5432
      - target: 6000
        published: 6000
        host_ip: 127.0.0.1
      - target: 7000
  worker:
    image: worker
`);

  it('lists the host ports published on every interface, not the random or address-bound ones', () => {
    expect(publishedPorts(compose).map(describePublished)).toEqual([
      'web 8080/tcp',
      'web 8443/udp',
      'web 8000-8010/tcp',
      'db 5432/tcp',
    ]);
  });

  it('keeps the published ports no rule opens', () => {
    const closed = closedPorts(publishedPorts(compose), [anyone(8080), anyone(8000, 8100), { ...anyone(5432), sources: ['10.0.0.0/8'] }]);
    expect(closed.map(describePublished)).toEqual(['web 8443/udp']);
  });
});

describe('recordCommand', () => {
  it('records through sudo, or straight as root, and says when the node has no filter', () => {
    const command = recordCommand('shop-production', [anyone(80)], 'deploy');
    expect(command).toContain("sudo -n /usr/local/sbin/dockflow-public-ports set 'shop-production' '80/tcp'");
    expect(command).toContain('echo off');
    expect(command).toContain('echo missing');
    expect(recordCommand('shop-production', [], 'root')).toContain("then /usr/local/sbin/dockflow-public-ports set 'shop-production';");
  });
});

describe('currentPublicPorts', () => {
  it('groups the published ports by project, accessories with their app', () => {
    const services = [
      'shop-production|8080/tcp 8443/tcp ',
      'shop-production-accessories|5432/tcp ',
      'traefik|80/tcp 443/tcp ',
      '|9000/tcp ',
      'weird name|7000/tcp ',
      'blog-staging|',
    ].join('\n');
    const containers = [
      '|0.0.0.0:3000->3000/tcp, [::]:3000->3000/tcp, 127.0.0.1:9100->9100/tcp, [::1]:9200->9200/tcp',
      '|0.0.0.0:6000-6002->6000-6002/udp, 80/tcp',
      'abc123|0.0.0.0:8080->80/tcp',
    ].join('\n');

    expect(Object.fromEntries(currentPublicPorts(services, containers))).toEqual({
      'shop-production': ['5432/tcp', '8080/tcp', '8443/tcp'],
      traefik: ['443/tcp', '80/tcp'],
      services: ['7000/tcp', '9000/tcp'],
      containers: ['3000/tcp', '6000-6002/udp'],
    });
  });
});

// The script runs for real, with fake `ip`, `iptables`, `iptables-restore` and `ip6tables` first
// on the PATH. Linux CI has bash; on Windows this needs Git Bash, and the tests are skipped
// without it.
describe('dockflow-public-ports', () => {
  const bash = resolveLocalBash();
  const SCRIPT = join(import.meta.dir, '..', 'services', 'public-ports.sh').replace(/\\/g, '/');
  let dir = '';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dockflow-public-ports-')).replace(/\\/g, '/');
    mkdirSync(`${dir}/bin`);
    mkdirSync(`${dir}/state`);
    const fake = (name: string, body: string) => {
      writeFileSync(`${dir}/bin/${name}`, `#!/usr/bin/env bash\n${body}\n`);
      chmodSync(`${dir}/bin/${name}`, 0o755);
    };
    fake('ip', [
      'case "$1" in',
      '-4) echo "default via 203.0.113.1 dev eth0 proto static" ;;',
      '-6) echo "default via fe80::1 dev eth0 proto ra metric 1024" ;;',
      'esac',
    ].join('\n'));
    // DOCKER-USER exists, the jump to the chain does not yet
    fake('iptables', `echo "$*" >> "${dir}/iptables.log"\ncase "$*" in *"-C DOCKER-USER"*) exit 1 ;; esac`);
    fake('iptables-restore', `cat >> "${dir}/restore.log"`);
    // a kernel without IPv6 filtering
    fake('ip6tables', 'exit 1');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const run = async (...args: string[]) => {
    const proc = Bun.spawn([bash as string, SCRIPT, ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        PATH: [`${dir}/bin`, process.env.PATH].join(process.platform === 'win32' ? ';' : ':'),
        DOCKFLOW_PUBLIC_PORTS_DIR: `${dir}/state`,
      },
    });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;
    return { exitCode: proc.exitCode, stdout, stderr };
  };
  const rules = (output: string) => output.split('\n').filter((line) => line.startsWith('-A '));

  it.skipIf(!bash)('renders, per family, the union of the projects then a drop on the internet interfaces', async () => {
    writeFileSync(`${dir}/state/shop-production`, '443/tcp@173.245.48.0/20,2400:cb00::/32\n8000-8010/udp\n');
    writeFileSync(`${dir}/state/traefik`, '80/tcp\n443/tcp@173.245.48.0/20,2400:cb00::/32\n');
    const match = '-p tcp -m conntrack --ctstate DNAT --ctorigdstport';

    const v4 = await run('render', '4');
    expect(v4.stdout.split('\n')[1]).toBe(':DOCKFLOW-PUBLIC-PORTS - [0:0]');
    expect(rules(v4.stdout)).toEqual([
      '-A DOCKFLOW-PUBLIC-PORTS -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN',
      `-A DOCKFLOW-PUBLIC-PORTS -i eth0 -s 173.245.48.0/20 ${match} 443 --ctdir ORIGINAL -j RETURN`,
      `-A DOCKFLOW-PUBLIC-PORTS -i eth0 ${match} 80 --ctdir ORIGINAL -j RETURN`,
      '-A DOCKFLOW-PUBLIC-PORTS -i eth0 -p udp -m conntrack --ctstate DNAT --ctorigdstport 8000:8010 --ctdir ORIGINAL -j RETURN',
      '-A DOCKFLOW-PUBLIC-PORTS -i eth0 -m conntrack --ctstate DNAT -j DROP',
    ]);
    expect(rules((await run('render', '6')).stdout)[1]).toBe(`-A DOCKFLOW-PUBLIC-PORTS -i eth0 -s 2400:cb00::/32 ${match} 443 --ctdir ORIGINAL -j RETURN`);
  });

  it.skipIf(!bash)('skips what it would not have recorded: bad lines, bad file names', async () => {
    writeFileSync(`${dir}/state/shop`, '80/tcp\n80/tcp -j ACCEPT\n99999/tcp\n');
    writeFileSync(`${dir}/state/.hidden`, '22/tcp\n');
    const ports = rules((await run('render', '4')).stdout).filter((rule) => rule.includes('ctorigdstport'));
    expect(ports).toEqual(['-A DOCKFLOW-PUBLIC-PORTS -i eth0 -p tcp -m conntrack --ctstate DNAT --ctorigdstport 80 --ctdir ORIGINAL -j RETURN']);
  });

  it.skipIf(!bash)('records a project, loads the chain and jumps to it from the top of DOCKER-USER', async () => {
    const result = await run('set', 'shop-production', '1883/tcp', '443/tcp@173.245.48.0/20');

    expect(result.exitCode).toBe(0);
    expect(readFileSync(`${dir}/state/shop-production`, 'utf-8')).toBe('1883/tcp\n443/tcp@173.245.48.0/20\n');
    expect(readFileSync(`${dir}/restore.log`, 'utf-8')).toContain('--ctorigdstport 1883');
    expect(readFileSync(`${dir}/iptables.log`, 'utf-8')).toContain('-w -I DOCKER-USER 1 -j DOCKFLOW-PUBLIC-PORTS');
  });

  it.skipIf(!bash)('says when Docker does not send published ports through DOCKER-USER', async () => {
    writeFileSync(`${dir}/bin/iptables`, '#!/usr/bin/env bash\ncase "$*" in *"-C "*) exit 1 ;; esac\n');
    const result = await run('set', 'shop-production', '80/tcp');

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain('Docker does not send published ports through DOCKER-USER here');
    expect(readFileSync(`${dir}/state/shop-production`, 'utf-8')).toBe('80/tcp\n');
  });

  it.skipIf(!bash)('forgets a project given no port', async () => {
    writeFileSync(`${dir}/state/shop-production`, '80/tcp\n');
    expect((await run('set', 'shop-production')).exitCode).toBe(0);
    expect(existsSync(`${dir}/state/shop-production`)).toBe(false);
  });

  it.skipIf(!bash)('refuses a project name or a port it could not trust, and records nothing', async () => {
    for (const args of [['../etc', '80/tcp'], ['shop', '80/tcp -j ACCEPT'], ['shop', '70000/tcp'], ['shop', '80'], ['shop', '443/tcp@1.2.3.4;reboot']]) {
      const result = await run('set', ...args);
      expect({ args, exitCode: result.exitCode }).toEqual({ args, exitCode: 1 });
    }
    expect(existsSync(`${dir}/restore.log`)).toBe(false);
    expect(existsSync(`${dir}/state/shop`)).toBe(false);
  });
});
