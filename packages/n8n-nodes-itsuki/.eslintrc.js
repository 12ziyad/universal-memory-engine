module.exports = {
	root: true,
	parser: '@typescript-eslint/parser',
	parserOptions: {
		project: './tsconfig.json',
		sourceType: 'module',
	},
	plugins: ['n8n-nodes-base'],
	overrides: [
		{
			files: ['credentials/**/*.ts'],
			extends: ['plugin:n8n-nodes-base/credentials'],
			rules: {
				// The rule's own docs: "Only applicable to nodes in the main
				// repository." Community credentials use a full docs URL.
				'n8n-nodes-base/cred-class-field-documentation-url-miscased': 'off',
			},
		},
		{
			files: ['nodes/**/*.node.ts'],
			extends: ['plugin:n8n-nodes-base/nodes'],
		},
	],
	ignorePatterns: ['dist/**', 'node_modules/**', 'test/**', 'scripts/**', 'vitest.config.ts'],
};
