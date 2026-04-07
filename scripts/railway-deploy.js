#!/usr/bin/env node
/**
 * Deploy Momentum Rider Bot to Railway via GraphQL API
 */
import 'dotenv/config';

const TOKEN = process.env.RAILWAY_TOKEN;
const API = 'https://backboard.railway.app/graphql/v2';
const PROJECT_ID = 'c0386cbd-8a00-4e82-9692-e7357dff9ef9';
const ENV_ID = '498ee1e9-9499-47cc-94ce-8b21c307ef1c';
const SERVICE_ID = '23aa756d-8c2c-492c-a43a-5252925350a2';

async function gql(query, variables = {}) {
  const res = await fetch(API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  const data = await res.json();
  if (data.errors) {
    console.error('GraphQL error:', JSON.stringify(data.errors, null, 2));
    throw new Error(data.errors[0].message);
  }
  return data.data;
}

async function main() {
  console.log('=== Railway Deployment ===\n');

  // 1. Set environment variables
  console.log('1. Setting environment variables...');
  const vars = {
    HL_PRIVATE_KEY: process.env.HL_PRIVATE_KEY,
    HL_TESTNET: process.env.HL_TESTNET || 'false',
    DRY_RUN: process.env.DRY_RUN || 'false',
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
    LEVERAGE: process.env.LEVERAGE || '3',
    RISK_PCT: process.env.RISK_PCT || '10',
    SLIPPAGE: process.env.SLIPPAGE || '0.05',
    SL_ATR_MULT: process.env.SL_ATR_MULT || '1.5',
    TP_ATR_MULT: process.env.TP_ATR_MULT || '3.0',
    PORT: '3142',
  };

  await gql(`
    mutation($input: VariableCollectionUpsertInput!) {
      variableCollectionUpsert(input: $input)
    }
  `, {
    input: {
      projectId: PROJECT_ID,
      environmentId: ENV_ID,
      serviceId: SERVICE_ID,
      variables: vars,
    },
  });
  console.log('   Environment variables set!\n');

  // 2. Configure service settings (Dockerfile, start command)
  console.log('2. Configuring service...');
  await gql(`
    mutation($id: String!, $input: ServiceInstanceUpdateInput!) {
      serviceInstanceUpdate(serviceId: $id, environmentId: "${ENV_ID}", input: $input)
    }
  `, {
    id: SERVICE_ID,
    input: {
      startCommand: 'node scripts/hyperliquid-bot.js',
      healthcheckPath: '/health',
      restartPolicyType: 'ON_FAILURE',
      restartPolicyMaxRetries: 10,
    },
  });
  console.log('   Service configured!\n');

  // 3. Create a GitHub-based deployment or upload
  // For now, let's use the Railway CLI approach with the linked project
  // We need to trigger a deployment from source
  console.log('3. Creating deployment...');

  // Check if there's a connected repo, if not we'll use CLI deploy
  const serviceInfo = await gql(`
    query {
      service(id: "${SERVICE_ID}") {
        id
        name
        repoTriggers {
          edges {
            node {
              id
              repository
              branch
            }
          }
        }
      }
    }
  `);
  console.log('   Service:', serviceInfo.service.name);

  const triggers = serviceInfo.service.repoTriggers.edges;
  if (triggers.length === 0) {
    console.log('   No repo connected. Connecting to GitHub...');

    // Get the repo URL from git
    const { execSync } = await import('node:child_process');
    let repoUrl;
    try {
      repoUrl = execSync('git remote get-url origin', { encoding: 'utf8' }).trim();
    } catch {
      repoUrl = null;
    }

    if (repoUrl) {
      // Extract owner/repo from git URL
      const match = repoUrl.match(/github\.com[:/](.+?)(?:\.git)?$/);
      if (match) {
        const fullRepo = match[1];
        console.log(`   Connecting repo: ${fullRepo}`);

        try {
          await gql(`
            mutation {
              serviceConnect(
                id: "${SERVICE_ID}"
                input: {
                  repo: "${fullRepo}"
                  branch: "main"
                }
              ) {
                id
              }
            }
          `);
          console.log('   Repo connected! Deployment will start automatically.\n');
        } catch (e) {
          console.log(`   Could not connect repo: ${e.message}`);
          console.log('   You may need to install the Railway GitHub app first.');
          console.log('   Go to: https://railway.app/project/' + PROJECT_ID + '/settings\n');
        }
      }
    } else {
      console.log('   No git remote found. Please connect a repo manually.');
      console.log('   Or use: railway link && railway up\n');
    }
  } else {
    console.log('   Repo already connected:', triggers[0].node.repository);
    // Trigger redeploy
    await gql(`
      mutation {
        deploymentTriggerUpdate(id: "${triggers[0].node.id}", input: {})
      }
    `);
    console.log('   Redeployment triggered!\n');
  }

  // 4. Generate domain
  console.log('4. Setting up domain...');
  try {
    const domain = await gql(`
      mutation {
        serviceDomainCreate(input: {
          serviceId: "${SERVICE_ID}"
          environmentId: "${ENV_ID}"
        }) {
          domain
        }
      }
    `);
    const url = domain.serviceDomainCreate.domain;
    console.log(`   Domain: https://${url}`);
    console.log(`   Webhook URL: https://${url}/webhook`);
    console.log(`   Status URL: https://${url}/status\n`);
  } catch (e) {
    // Domain might already exist
    console.log(`   Domain setup: ${e.message}`);
    // Fetch existing domains
    const existing = await gql(`
      query {
        service(id: "${SERVICE_ID}") {
          serviceDomains {
            edges { node { domain } }
          }
        }
      }
    `);
    const domains = existing.service.serviceDomains.edges;
    if (domains.length > 0) {
      const url = domains[0].node.domain;
      console.log(`   Existing domain: https://${url}`);
      console.log(`   Webhook URL: https://${url}/webhook`);
      console.log(`   Status URL: https://${url}/status\n`);
    }
  }

  console.log('=== Deployment Complete ===');
  console.log('\nSet your TradingView alert webhook URL to the webhook URL above.');
}

main().catch(e => {
  console.error('Deploy failed:', e.message);
  process.exit(1);
});
