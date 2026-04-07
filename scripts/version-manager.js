#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

class VersionManager {
    constructor() {
        this.packageJsonPath = path.join(process.cwd(), 'package.json');
        this.excludeDirs = ['node_modules', '.git', 'dist', 'build', 'coverage', 'scripts'];
        this.includeExtensions = ['.yml', '.yaml', '.json', '.md', '.js', '.ts', '.sh', '.ps1'];
    }

    getCurrentVersion() {
        try {
            const packageJson = JSON.parse(fs.readFileSync(this.packageJsonPath, 'utf8'));
            return packageJson.version;
        } catch (error) {
            console.error('Error reading package.json:', error.message);
            process.exit(1);
        }
    }

    parseVersion(version) {
        const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-dev(\d+))?$/);
        if (!match) {
            throw new Error(`Invalid version format: ${version}`);
        }

        return {
            major: parseInt(match[1]),
            minor: parseInt(match[2]),
            patch: parseInt(match[3]),
            dev: match[4] ? parseInt(match[4]) : null
        };
    }

    incrementVersion(currentVersion, type) {
        const parsed = this.parseVersion(currentVersion);

        switch (type) {
            case 'dev':
                if (parsed.dev !== null) {
                    parsed.dev++;
                } else {
                    parsed.dev = 1;
                }
                break;

            case 'release':
                if (parsed.dev !== null) {
                    parsed.patch++;
                    parsed.dev = null;
                } else {
                    parsed.patch++;
                }
                break;

            case 'downgrade':
                if (parsed.dev !== null) {
                    if (parsed.dev > 1) {
                        parsed.dev--;
                    } else {
                        parsed.dev = null;
                    }
                } else {
                    if (parsed.patch > 0) {
                        parsed.patch--;
                    } else if (parsed.minor > 0) {
                        parsed.minor--;
                        parsed.patch = 0;
                    } else if (parsed.major > 0) {
                        parsed.major--;
                        parsed.minor = 0;
                        parsed.patch = 0;
                    }
                }
                break;

            default:
                throw new Error(`Invalid increment type: ${type}. Use 'dev', 'release' or 'downgrade'.`);
        }

        return `${parsed.major}.${parsed.minor}.${parsed.patch}${parsed.dev !== null ? `-dev${parsed.dev}` : ''}`;
    }

    updatePackageJson(newVersion) {
        try {
            const packageJson = JSON.parse(fs.readFileSync(this.packageJsonPath, 'utf8'));
            packageJson.version = newVersion;
            fs.writeFileSync(this.packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n');
            console.log(`✓ Updated package.json version: ${newVersion}`);

            // Also update cli-ts/package.json version to keep in sync
            const cliPackageJsonPath = path.join(process.cwd(), 'cli-ts', 'package.json');
            if (fs.existsSync(cliPackageJsonPath)) {
                const cliPackageJson = JSON.parse(fs.readFileSync(cliPackageJsonPath, 'utf8'));
                cliPackageJson.version = newVersion;
                fs.writeFileSync(cliPackageJsonPath, JSON.stringify(cliPackageJson, null, 2) + '\n');
                console.log(`✓ Updated cli-ts/package.json version: ${newVersion}`);
            }

            const npmCliPackageJsonPath = path.join(process.cwd(), 'packages', 'cli', 'package.json');
            if (fs.existsSync(npmCliPackageJsonPath)) {
                const npmCliPackageJson = JSON.parse(fs.readFileSync(npmCliPackageJsonPath, 'utf8'));
                npmCliPackageJson.version = newVersion;
                fs.writeFileSync(npmCliPackageJsonPath, JSON.stringify(npmCliPackageJson, null, 2) + '\n');
                console.log(`✓ Updated packages/cli/package.json version: ${newVersion}`);
            }
        } catch (error) {
            console.error('Error updating package.json:', error.message);
            throw error;
        }
    }

    findFilesRecursively(dir, files = []) {
        try {
            const items = fs.readdirSync(dir);

            for (const item of items) {
                const fullPath = path.join(dir, item);
                const stat = fs.statSync(fullPath);

                if (stat.isDirectory()) {
                    if (!this.excludeDirs.includes(item)) {
                        this.findFilesRecursively(fullPath, files);
                    }
                } else if (stat.isFile()) {
                    const ext = path.extname(item);
                    if (this.includeExtensions.includes(ext)) {
                        files.push(fullPath);
                    }
                }
            }
        } catch (error) {
            console.warn(`⚠ Cannot read directory ${dir}: ${error.message}`);
        }

        return files;
    }

    findFilesContainingVersion(version) {
        const allFiles = this.findFilesRecursively(process.cwd());
        const filesWithVersion = [];

        const versionPattern = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const versionRegex = new RegExp(versionPattern, 'g');

        for (const filePath of allFiles) {
            if (filePath === this.packageJsonPath) continue;
            if (filePath.endsWith('version-manager.js')) continue;
            if (filePath.endsWith('package-lock.json')) continue;
            if (filePath.endsWith('pnpm-lock.yaml')) continue;
            if (filePath.endsWith('bun.lockb')) continue;
            if (filePath.endsWith('.md')) continue;

            try {
                const content = fs.readFileSync(filePath, 'utf8');
                if (versionRegex.test(content)) {
                    filesWithVersion.push(filePath);
                }
                versionRegex.lastIndex = 0;
            } catch (error) {
                console.warn(`⚠ Cannot read ${filePath}: ${error.message}`);
            }
        }

        return filesWithVersion;
    }

    updateFilesWithVersion(oldVersion, newVersion) {
        console.log(`🔍 Searching for files containing version...`);
        const filesToUpdate = this.findFilesContainingVersion(oldVersion);

        if (filesToUpdate.length === 0) {
            console.log(`ℹ No files found containing current version`);
            return 0;
        }

        console.log(`📁 ${filesToUpdate.length} file(s) found containing version ${oldVersion}`);

        let updatedFiles = 0;
        const escapedOldVersion = oldVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

        filesToUpdate.forEach(fullPath => {
            try {
                let content = fs.readFileSync(fullPath, 'utf8');
                const originalContent = content;

                content = content.replace(new RegExp(escapedOldVersion, 'g'), newVersion);

                if (content !== originalContent) {
                    fs.writeFileSync(fullPath, content);
                    const relativePath = path.relative(process.cwd(), fullPath);
                    console.log(`✓ Updated ${relativePath}`);
                    updatedFiles++;
                }
            } catch (error) {
                const relativePath = path.relative(process.cwd(), fullPath);
                console.error(`❌ Error updating ${relativePath}:`, error.message);
            }
        });

        return updatedFiles;
    }

    run(type, push = false) {
        try {
            const currentVersion = this.getCurrentVersion();
            console.log(`Current version: ${currentVersion}`);

            const newVersion = this.incrementVersion(currentVersion, type);
            console.log(`New version: ${newVersion}`);

            this.updatePackageJson(newVersion);

            const updatedFiles = this.updateFilesWithVersion(currentVersion, newVersion);

            console.log(`\n🎉 Version updated successfully!`);
            console.log(`📦 ${currentVersion} → ${newVersion}`);
            console.log(`📁 ${updatedFiles + 1} file(s) modified`);

            if (push) {
                this.gitPushRelease(newVersion);
            }

        } catch (error) {
            console.error('❌ Error:', error.message);
            process.exit(1);
        }
    }

    gitPushRelease(version) {
        const { execSync } = require('child_process');

        try {
            console.log('\n📤 Pushing release...');

            execSync('git add -A', { stdio: 'inherit' });
            execSync(`git commit -m "release: ${version}"`, { stdio: 'inherit' });
            execSync('git push', { stdio: 'inherit' });
            execSync(`git tag ${version}`, { stdio: 'inherit' });
            execSync(`git push origin ${version}`, { stdio: 'inherit' });

            console.log(`\n✅ Released and tagged: ${version}`);
        } catch (error) {
            console.error('❌ Git operation failed:', error.message);
            process.exit(1);
        }
    }
}

// Script execution
const args = process.argv.slice(2);
const type = args[0];
const push = args.includes('--push');

if (!type || !['dev', 'release', 'downgrade'].includes(type)) {
    console.log('Usage: node version-manager.js <type> [--push]');
    console.log('Available types:');
    console.log('  dev       - Add or increment dev version (1.0.33 → 1.0.33-dev1 or 1.0.33-dev1 → 1.0.33-dev2)');
    console.log('  release   - Create release version (1.0.33-dev1 → 1.0.34) or increment (1.0.33 → 1.0.34)');
    console.log('  downgrade - Decrement version (1.0.33-dev2 → 1.0.33-dev1 or 1.0.33 → 1.0.32)');
    console.log('');
    console.log('Flags:');
    console.log('  --push     - Git add, commit, push, and create tag automatically');
    process.exit(1);
}

const versionManager = new VersionManager();
versionManager.run(type, push);
