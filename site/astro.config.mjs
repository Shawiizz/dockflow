// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
	site: 'https://dockflow.shawiizz.dev',
	integrations: [
		starlight({
			title: 'Dockflow',
			description:
				'Deploy your Docker Compose apps to your own server, with zero downtime, a plan before every change and rollbacks that always finish.',
			logo: { src: './src/assets/logo.svg' },
			favicon: '/favicon.svg',
			social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/Shawiizz/dockflow' }],
			editLink: { baseUrl: 'https://github.com/Shawiizz/dockflow/edit/main/site/' },
			customCss: [
				'@fontsource-variable/inter',
				'@fontsource-variable/jetbrains-mono',
				'@fontsource-variable/space-grotesk',
				'./src/styles/theme.css',
			],
			expressiveCode: {
				themes: ['github-dark-default', 'github-light-default'],
				styleOverrides: { borderRadius: '0.7rem', codeFontFamily: 'var(--sl-font-mono)' },
			},
			sidebar: [
				{ label: 'Start here', items: [{ autogenerate: { directory: 'start' } }] },
				{ label: 'Concepts', items: [{ autogenerate: { directory: 'concepts' } }] },
				{ label: 'Guides', items: [{ autogenerate: { directory: 'guides' } }] },
				{ label: 'Reference', items: [{ autogenerate: { directory: 'reference' } }] },
				{ label: 'Project', items: [{ autogenerate: { directory: 'project' } }] },
			],
		}),
	],
});
