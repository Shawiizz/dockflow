#!/usr/bin/env node

const { execSync } = require('child_process');

const version = process.argv[2];

if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
    console.error('Usage: node delete-dev-tags.js <version>');
    console.error('Example: node delete-dev-tags.js 1.0.48');
    process.exit(1);
}

const tags = execSync('git tag', { encoding: 'utf-8' })
    .trim()
    .split('\n')
    .filter(tag => tag.startsWith(`${version}-dev`));

if (tags.length === 0) {
    console.log(`No dev tags found for ${version}`);
    process.exit(0);
}

console.log(`Deleting ${tags.length} tag(s): ${tags.join(', ')}\n`);

tags.forEach(tag => {
    try {
        execSync(`git tag -d ${tag}`, { stdio: 'inherit' });
        execSync(`git push origin :refs/tags/${tag}`, { stdio: 'inherit' });
    } catch (error) {
        console.error(`Failed to delete ${tag}`);
    }
});

console.log('\nDone');

