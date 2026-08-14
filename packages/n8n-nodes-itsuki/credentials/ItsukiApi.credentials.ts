import type {
	IAuthenticateGeneric,
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

/**
 * Itsuki API credential.
 *
 * The secret is a project-bound Itsuki key (`itsuki_live_…`). It is sent only
 * as an Authorization header — never in the URL, query string, or workflow
 * output. The credential test calls GET /v1/status, which is authenticated but
 * content-free: it returns aggregate counts, never memory content and never
 * the key.
 */
export class ItsukiApi implements ICredentialType {
	name = 'itsukiApi';

	displayName = 'Itsuki API';

	icon: Icon = { light: 'file:../nodes/Itsuki/itsuki.svg', dark: 'file:../nodes/Itsuki/itsuki.dark.svg' };

	documentationUrl = 'https://itsuki.app/docs';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description:
				'An Itsuki project key (starts with itsuki_live_). Create one in the dashboard under API Keys. The key is bound to one project.',
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://itsuki.app',
			description:
				'Leave at https://itsuki.app unless you are pointing at a development server. HTTPS is required except for explicit loopback (localhost / 127.0.0.1). URLs carrying credentials, query strings, or fragments are rejected.',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl.replace(new RegExp("/+$"), "")}}',
			url: '/v1/status',
			method: 'GET',
		},
	};
}
