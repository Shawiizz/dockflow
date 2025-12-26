#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

class VersionManager {
    constructor(ciImageMode = false) {
        this.packageJsonPath = path.join(process.cwd(), 'package.json');
        this.excludeDirs = ['node_modules', '.git', 'dist', 'build', 'coverage', 'scripts'];
        this.includeExtensions = ['.yml', '.yaml', '.json', '.md', '.js', '.ts', '.sh'];
        this.ciImageMode = ciImageMode;
    }

    getCurrentVersion() {
        try {
            const packageJson = JSON.parse(fs.readFileSync(this.packageJsonPath, 'utf8'));
            return this.ciImageMode ? packageJson.ciImageVersion : packageJson.version;
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
                        // If in dev1, switch to release version (removes -dev1)
                        parsed.dev = null;
                    }
                } else {
                    // If in release, decrement patch
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

        const newVersion = `${parsed.major}.${parsed.minor}.${parsed.patch}${parsed.dev !== null ? `-dev${parsed.dev}` : ''}`;
        return newVersion;
    }

    updatePackageJson(newVersion) {
        try {
            // Update root package.json
            const packageJson = JSON.parse(fs.readFileSync(this.packageJsonPath, 'utf8'));
            if (this.ciImageMode) {
                packageJson.ciImageVersion = newVersion;
                console.log(`✓ Updated package.json ciImageVersion: ${newVersion}`);
            } else {
                packageJson.version = newVersion;
                console.log(`✓ Updated package.json version: ${newVersion}`);
            }
            fs.writeFileSync(this.packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n');
            
            // Also update cli-ts/package.json version to keep in sync
            if (!this.ciImageMode) {
                const cliPackageJsonPath = path.join(process.cwd(), 'cli-ts', 'package.json');
                if (fs.existsSync(cliPackageJsonPath)) {
                    const cliPackageJson = JSON.parse(fs.readFileSync(cliPackageJsonPath, 'utf8'));
                    cliPackageJson.version = newVersion;
                    fs.writeFileSync(cliPackageJsonPath, JSON.stringify(cliPackageJson, null, 2) + '\n');
                    console.log(`✓ Updated cli-ts/package.json version: ${newVersion}`);
                }
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
            
            try {
                const content = fs.readFileSync(filePath, 'utf8');
                if (this.ciImageMode) {
                    // For CI image mode, look specifically for dockflow-ci image references
                    if (content.includes(`shawiizz/dockflow-ci:${version}`) || content.includes(`dockflow-ci:${version}`)) {
                        filesWithVersion.push(filePath);
                    }
                } else {
                    // For normal mode, just check if the version appears anywhere (but not in Docker images)
                    const hasVersion = versionRegex.test(content);
                    const hasDockerImage = content.includes(`shawiizz/dockflow-ci:${version}`);
                    
                    if (hasVersion && !hasDockerImage) {
                        filesWithVersion.push(filePath);
                    }
                    
                    // Reset regex state for next iteration
                    versionRegex.lastIndex = 0;
                }
            } catch (error) {
                console.warn(`⚠ Cannot read ${filePath}: ${error.message}`);
            }
        }
        
        return filesWithVersion;
    }

    updateFilesWithVersion(oldVersion, newVersion) {
        const searchType = this.ciImageMode ? 'CI Docker image' : 'framework';
        console.log(`🔍 Searching for files containing ${searchType} version...`);
        const filesToUpdate = this.findFilesContainingVersion(oldVersion);
        
        if (filesToUpdate.length === 0) {
            console.log(`ℹ No files found containing current ${searchType} version`);
            return 0;
        }
        
        console.log(`📁 ${filesToUpdate.length} file(s) found containing ${searchType} version ${oldVersion}`);
        
        let updatedFiles = 0;
        
        filesToUpdate.forEach(fullPath => {
            try {
                let content = fs.readFileSync(fullPath, 'utf8');
                const originalContent = content;
                
                // Detect original line ending style
                const hasWindowsLineEndings = content.includes('\r\n');
                const lineEnding = hasWindowsLineEndings ? '\r\n' : '\n';
                
                if (this.ciImageMode) {
                    // For CI image mode, replace specifically image references
                    content = content.replace(new RegExp(`shawiizz/dockflow-ci:${oldVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g'), `shawiizz/dockflow-ci:${newVersion}`);
                    content = content.replace(new RegExp(`dockflow-ci:${oldVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g'), `dockflow-ci:${newVersion}`);
                } else {
                    // For normal mode, simply replace all occurrences of the version (except in Docker images)
                    const lines = content.split(/\r?\n/);
                    const updatedLines = lines.map(line => {
                        if (line.includes('shawiizz/dockflow-ci:') || line.includes('dockflow-ci:')) {
                            return line; // Don't modify lines containing Docker references
                        }
                        return line.replace(new RegExp(oldVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), newVersion);
                    });
                    content = updatedLines.join(lineEnding);
                }
                
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

    run(type) {
        try {
            const currentVersion = this.getCurrentVersion();
            const versionType = this.ciImageMode ? 'CI Docker image' : 'Framework';
            console.log(`Current ${versionType} version: ${currentVersion}`);
            
            const newVersion = this.incrementVersion(currentVersion, type);
            console.log(`New ${versionType} version: ${newVersion}`);
            
            this.updatePackageJson(newVersion);
            
            const updatedFiles = this.updateFilesWithVersion(currentVersion, newVersion);
            
            console.log(`\n🎉 ${versionType} version updated successfully!`);
            console.log(`📦 ${currentVersion} → ${newVersion}`);
            console.log(`📁 ${updatedFiles + 1} file(s) modified`);
            
        } catch (error) {
            console.error('❌ Error:', error.message);
            process.exit(1);
        }
    }
}

// Script execution
const args = process.argv.slice(2);
const type = args[0];
const ciImageMode = args.includes('--ci-image');

if (!type || !['dev', 'release', 'downgrade'].includes(type)) {
    console.log('Usage: node version-manager.js <type> [--ci-image]');
    console.log('Available types:');
    console.log('  dev       - Add or increment dev version (1.0.33 → 1.0.33-dev1 or 1.0.33-dev1 → 1.0.33-dev2)');
    console.log('  release   - Create release version (1.0.33-dev1 → 1.0.34) or increment (1.0.33 → 1.0.34)');
    console.log('  downgrade - Decrement version (1.0.33-dev2 → 1.0.33-dev1 or 1.0.33 → 1.0.32)');
    console.log('');
    console.log('Flags:');
    console.log('  --ci-image - Update CI Docker image version instead of framework version');
    process.exit(1);
}

const versionManager = new VersionManager(ciImageMode);
versionManager.run(type);