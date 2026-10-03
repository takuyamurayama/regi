import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { bootstrapApplicationRole, scramVerifier } from '../scripts/sandbox-db-role';
import { Auth } from '../apps/api/src/auth';
import { Database } from '../apps/api/src/db';

test('production API never accepts development headers or enables a public development auth bypass', async () => {
  const keys = ['NODE_ENV', 'REGI_DEV_AUTH', 'COGNITO_ISSUER', 'COGNITO_CLIENT_ID'],
    saved = Object.fromEntries(keys.map((key) => [key, process.env[key]])),
    database = new Database();
  try {
    process.env.NODE_ENV = 'production';
    process.env.REGI_DEV_AUTH = 'false';
    process.env.COGNITO_ISSUER =
      'https://cognito-idp.ap-northeast-1.amazonaws.com/synthetic-test-pool';
    process.env.COGNITO_CLIENT_ID = 'synthetic-test-client';
    const auth = new Auth(database),
      context: any = {
        switchToHttp: () => ({
          getRequest: () => ({
            path: '/v1/settings',
            headers: { 'x-tenant-id': randomUUID(), 'x-staff-subject': 'local-admin' },
          }),
        }),
      };
    await assert.rejects(
      () => auth.canActivate(context),
      (error: any) => error.code === 'UNAUTHENTICATED' && error.status === 401,
    );
    process.env.REGI_DEV_AUTH = 'true';
    await assert.rejects(
      () => auth.canActivate(context),
      (error: any) => error.code === 'DEV_AUTH_FORBIDDEN',
    );
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    await database.client.$disconnect();
  }
});

test('real PostgreSQL application role has SCRAM verifier and cannot become owner/superuser/RLS bypass', async () => {
  const url = new URL(
    process.env.SANDBOX_TEST_ADMIN_DATABASE_URL ?? process.env.DATABASE_URL ?? '',
  );
  assert.ok(['localhost', '127.0.0.1'].includes(url.hostname));
  if (!process.env.SANDBOX_TEST_ADMIN_DATABASE_URL) {
    url.username = 'postgres';
    url.password = '';
    url.pathname = '/postgres';
  }
  const owner = new PrismaClient({ datasourceUrl: url.toString() }),
    role = 'regi_sandbox_' + randomUUID().replaceAll('-', ''),
    unsafe = role + '_bad',
    password = randomBytes(36).toString('base64url');
  try {
    assert.deepEqual(await bootstrapApplicationRole(owner, password, role), { created: true });
    assert.deepEqual(await bootstrapApplicationRole(owner, password, role), { created: false });
    const [record] = await owner.$queryRawUnsafe<any[]>(
      'SELECT rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolreplication,rolpassword FROM pg_authid WHERE rolname=$1',
      role,
    );
    assert.ok(
      Object.entries(record)
        .filter(([key]) => key !== 'rolpassword')
        .every(([, value]) => value === false),
    );
    assert.ok(record.rolpassword.startsWith('SCRAM-SHA-256$4096:'));
    await owner.$executeRawUnsafe(`CREATE ROLE ${unsafe} SUPERUSER`);
    await assert.rejects(() => bootstrapApplicationRole(owner, password, unsafe), /UNSAFE/);
    await assert.rejects(
      () => bootstrapApplicationRole(owner, password, 'regi_app;DROP ROLE postgres'),
      /INPUT/,
    );
    assert.ok(!scramVerifier(password).includes(password));
  } finally {
    await owner.$executeRawUnsafe(`DROP ROLE IF EXISTS ${role}`);
    await owner.$executeRawUnsafe(`DROP ROLE IF EXISTS ${unsafe}`);
    await owner.$disconnect();
  }
});
test('power commands reject an account mismatch before starting/stopping any resource', () => {
  const directory = resolve('.context/control-test-' + randomUUID()),
    config = directory + '/control.json',
    log = directory + '/aws.log';
  mkdirSync(directory, { recursive: true });
  chmodSync('tests/fixtures/mock-sandbox-aws.sh', 0o755);
  symlinkSync(resolve('tests/fixtures/mock-sandbox-aws.sh'), directory + '/aws');
  writeFileSync(
    config,
    JSON.stringify({
      aws_profile: 'confirmed-profile',
      expected_account_id: '000000000001',
      region: 'ap-northeast-1',
      instance_id: 'i-00000000000000001',
      web_url: 'https://test.cloudfront.net',
    }),
    { mode: 0o600 },
  );
  const environment = {
    ...process.env,
    PATH: directory + ':' + process.env.PATH,
    REGI_SANDBOX_CONTROL_CONFIG: config,
    MOCK_AWS_LOG: log,
    MOCK_AWS_ACCOUNT: '000000000002',
  };
  assert.throws(() =>
    execFileSync('bash', ['scripts/sandbox-control.sh', 'start'], {
      env: environment,
      stdio: 'pipe',
    }),
  );
  const calls = readFileSync(log, 'utf8');
  assert.ok(calls.includes('sts get-caller-identity'));
  assert.ok(!calls.includes('start-instances'));
  assert.ok(calls.includes('--profile confirmed-profile --region ap-northeast-1'));
});
test('an already-running start resets the two-hour timer through SSM with explicit instance/profile', () => {
  const directory = resolve('.context/control-test-' + randomUUID()),
    config = directory + '/control.json',
    log = directory + '/aws.log';
  mkdirSync(directory, { recursive: true });
  symlinkSync(resolve('tests/fixtures/mock-sandbox-aws.sh'), directory + '/aws');
  writeFileSync(
    config,
    JSON.stringify({
      aws_profile: 'confirmed-profile',
      expected_account_id: '000000000001',
      region: 'ap-northeast-1',
      instance_id: 'i-00000000000000001',
      web_url: 'https://test.cloudfront.net',
    }),
    { mode: 0o600 },
  );
  execFileSync('bash', ['scripts/sandbox-control.sh', 'start'], {
    env: {
      ...process.env,
      PATH: directory + ':' + process.env.PATH,
      REGI_SANDBOX_CONTROL_CONFIG: config,
      MOCK_AWS_LOG: log,
      MOCK_AWS_ACCOUNT: '000000000001',
    },
    stdio: 'pipe',
  });
  const calls = readFileSync(log, 'utf8');
  assert.ok(calls.includes('systemctl restart regi-autostop.timer'));
  assert.ok(calls.includes('--instance-ids i-00000000000000001'));
  assert.ok(!calls.includes('modify-instance-attribute'));
});
void test('acknowledged sandbox start succeeds on headless Linux and when the optional Mac browser fails', () => {
  for (const platform of ['Linux', 'Darwin']) {
    const directory = resolve('.context/control-test-' + randomUUID()),
      config = directory + '/control.json',
      log = directory + '/aws.log',
      browserLog = directory + '/browser.log';
    mkdirSync(directory, { recursive: true });
    symlinkSync(resolve('tests/fixtures/mock-sandbox-aws.sh'), directory + '/aws');
    writeFileSync(directory + '/uname', `#!/usr/bin/env bash\nprintf '%s\\n' '${platform}'\n`, {
      mode: 0o755,
    });
    writeFileSync(
      directory + '/open',
      '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$MOCK_BROWSER_LOG"\nexit 3\n',
      { mode: 0o755 },
    );
    writeFileSync(
      config,
      JSON.stringify({
        aws_profile: 'confirmed-profile',
        expected_account_id: '000000000001',
        region: 'ap-northeast-1',
        instance_id: 'i-00000000000000001',
        web_url: 'https://test.cloudfront.net',
      }),
      { mode: 0o600 },
    );
    const result = spawnSync('bash', ['scripts/sandbox-control.sh', 'start'], {
      env: {
        ...process.env,
        PATH: directory + ':' + process.env.PATH,
        REGI_SANDBOX_CONTROL_CONFIG: config,
        MOCK_AWS_LOG: log,
        MOCK_AWS_ACCOUNT: '000000000001',
        MOCK_BROWSER_LOG: browserLog,
      },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `${platform}: ${result.stderr}`);
    assert.ok(result.stdout.includes('Started; auto-stop is reset to two hours.'));
    assert.ok(result.stdout.includes('https://test.cloudfront.net'));
    assert.ok(readFileSync(log, 'utf8').includes('ssm get-command-invocation'));
    if (platform === 'Darwin') {
      assert.equal(readFileSync(browserLog, 'utf8').trim(), 'https://test.cloudfront.net');
      assert.ok(result.stderr.includes('Browser could not open; use the URL above.'));
    } else assert.equal(existsSync(browserLog), false);
  }
});
test('stop waits for stopping to become stopped, and never reports a terminated or still-stopping instance as stopped', () => {
  for (const state of ['stopping', 'stopped', 'terminated']) {
    const directory = resolve('.context/control-test-' + randomUUID()),
      config = directory + '/control.json',
      log = directory + '/aws.log';
    mkdirSync(directory, { recursive: true });
    symlinkSync(resolve('tests/fixtures/mock-sandbox-aws.sh'), directory + '/aws');
    writeFileSync(
      config,
      JSON.stringify({
        aws_profile: 'confirmed-profile',
        expected_account_id: '000000000001',
        region: 'ap-northeast-1',
        instance_id: 'i-00000000000000001',
        web_url: 'https://test.cloudfront.net',
      }),
      { mode: 0o600 },
    );
    const environment = {
      ...process.env,
      PATH: directory + ':' + process.env.PATH,
      REGI_SANDBOX_CONTROL_CONFIG: config,
      MOCK_AWS_LOG: log,
      MOCK_AWS_ACCOUNT: '000000000001',
      MOCK_AWS_STATE: state,
    };
    if (state === 'terminated')
      assert.throws(() =>
        execFileSync('bash', ['scripts/sandbox-control.sh', 'stop'], {
          env: environment,
          stdio: 'pipe',
        }),
      );
    else {
      const output = execFileSync('bash', ['scripts/sandbox-control.sh', 'stop'], {
        env: environment,
        encoding: 'utf8',
      });
      assert.ok(output.includes('Stopped.'));
      const calls = readFileSync(log, 'utf8');
      assert.ok(!calls.includes('stop-instances'));
      assert.equal(calls.includes('wait instance-stopped'), state === 'stopping');
    }
    if (state === 'stopping') {
      execFileSync('rm', ['-f', log + '.state']);
      assert.throws(() =>
        execFileSync('bash', ['scripts/sandbox-control.sh', 'stop'], {
          env: { ...environment, MOCK_WAIT_STAYS_STOPPING: 'true' },
          stdio: 'pipe',
        }),
      );
    }
  }
});
test('stale SSM Online is not sufficient: start retries until a command actually succeeds', () => {
  const directory = resolve('.context/control-test-' + randomUUID()),
    config = directory + '/control.json',
    log = directory + '/aws.log';
  mkdirSync(directory, { recursive: true });
  symlinkSync(resolve('tests/fixtures/mock-sandbox-aws.sh'), directory + '/aws');
  writeFileSync(
    config,
    JSON.stringify({
      aws_profile: 'confirmed-profile',
      expected_account_id: '000000000001',
      region: 'ap-northeast-1',
      instance_id: 'i-00000000000000001',
      web_url: 'https://test.cloudfront.net',
    }),
    { mode: 0o600 },
  );
  execFileSync('bash', ['scripts/sandbox-control.sh', 'start'], {
    env: {
      ...process.env,
      PATH: directory + ':' + process.env.PATH,
      REGI_SANDBOX_CONTROL_CONFIG: config,
      MOCK_AWS_LOG: log,
      MOCK_AWS_ACCOUNT: '000000000001',
      MOCK_SSM_FIRST_FAILURE: 'true',
    },
    stdio: 'pipe',
  });
  const calls = readFileSync(log, 'utf8');
  assert.equal(calls.split('ssm send-command').length - 1, 2);
  assert.ok(calls.indexOf('wait instance-status-ok') < calls.indexOf('ssm send-command'));
});
test('auto-stop precedes every risky bootstrap command; existing disks and workload credentials fail closed', () => {
  const userData = readFileSync('infra/sandbox/host/user-data.sh.tftpl', 'utf8'),
    bootstrap = readFileSync('infra/sandbox/host/bootstrap.sh', 'utf8'),
    compose = readFileSync('infra/sandbox/host/compose.yaml', 'utf8');
  assert.ok(userData.indexOf('enable --now regi-autostop.timer') < userData.indexOf('dnf install'));
  assert.ok(userData.includes('dnf install -y docker python3 awscli-2'));
  assert.ok(!userData.includes('awscli2'));
  assert.ok(userData.includes('OnActiveSec=2h'));
  assert.ok(userData.indexOf('initialize-data-volume.approval') < userData.indexOf('mkfs.ext4'));
  assert.ok(userData.includes('mountpoint -q /var/lib/regi'));
  assert.ok(userData.includes('wipefs --no-act --json'));
  assert.ok(userData.includes('Existing partition, filesystem or mount'));
  assert.ok(userData.includes("= '${volume_id}'"));
  assert.ok(userData.includes("= '0:600'"));
  assert.ok(userData.indexOf('rm "$approval"') < userData.indexOf('mkfs.ext4'));
  assert.ok(
    userData.indexOf('sha256sum -c') <
      userData.indexOf('chmod 755 /usr/local/lib/docker/cli-plugins/docker-compose'),
  );
  assert.ok(bootstrap.includes('DOCKER-USER -d 169.254.169.254/32 -j REJECT'));
  const api = compose.slice(compose.indexOf('  api:'), compose.indexOf('  worker:'));
  assert.ok(!api.includes('maintenance.env'));
  assert.ok(!api.includes('/run/regi-private'));
  assert.ok(!compose.includes('5432:5432'));
  assert.ok(
    userData.indexOf('REGI initial host checksum mismatch') <
      userData.indexOf('/opt/regi/install-host.sh\n'),
  );
  const stop = readFileSync('infra/sandbox/host/regi-stop.sh', 'utf8'),
    service = readFileSync('infra/sandbox/host/regi.service', 'utf8'),
    timer = readFileSync('infra/sandbox/host/regi-backup.timer', 'utf8');
  assert.ok(stop.indexOf('backup.sh --reason stop') < stop.indexOf('compose.yaml stop -t 45'));
  assert.ok(stop.includes('continuing bounded shutdown'));
  assert.ok(service.includes('ExecStop=/opt/regi/regi-stop.sh'));
  assert.ok(service.includes('TimeoutStopSec=360'));
  assert.ok(timer.includes('OnCalendar=*-*-* *:00:00 UTC'));
  assert.ok(timer.includes('Persistent=true'));
  execFileSync('bash', ['-n', 'scripts/sandbox-control.sh', 'infra/sandbox/host/bootstrap.sh']);
  execFileSync('python3', [
    '-m',
    'py_compile',
    'infra/sandbox/host/bootstrap.py',
    'infra/sandbox/host/credentials.py',
  ]);
});
void test('stop observes bounded SSM backup completion before requesting normal guest shutdown', () => {
  const directory = resolve('.context/control-test-' + randomUUID()),
    config = directory + '/control.json',
    log = directory + '/aws.log';
  mkdirSync(directory, { recursive: true });
  symlinkSync(resolve('tests/fixtures/mock-sandbox-aws.sh'), directory + '/aws');
  writeFileSync(
    config,
    JSON.stringify({
      aws_profile: 'confirmed-profile',
      expected_account_id: '000000000001',
      region: 'ap-northeast-1',
      instance_id: 'i-00000000000000001',
      web_url: 'https://test.cloudfront.net',
    }),
    { mode: 0o600 },
  );
  const output = execFileSync('bash', ['scripts/sandbox-control.sh', 'stop'], {
    env: {
      ...process.env,
      PATH: directory + ':' + process.env.PATH,
      REGI_SANDBOX_CONTROL_CONFIG: config,
      MOCK_AWS_LOG: log,
      MOCK_AWS_ACCOUNT: '000000000001',
      MOCK_SSM_PENDING_POLLS: '2',
    },
    encoding: 'utf8',
  });
  const calls = readFileSync(log, 'utf8');
  assert.ok(output.includes('Stopped.'));
  const parameters = JSON.parse(calls.match(/--parameters (\{.*\}) --query/)?.[1] ?? '{}') as {
    executionTimeout: string[];
    commands: string[];
  };
  assert.deepEqual(parameters.executionTimeout, ['420']);
  assert.ok(parameters.commands.some((command) => command.includes('last-backup.json')));
  assert.ok(parameters.commands.some((command) => command.includes('r.get("reason")=="stop"')));
  assert.equal(calls.split('ssm get-command-invocation').length - 1, 3);
  assert.ok(calls.lastIndexOf('ssm get-command-invocation') < calls.indexOf('ec2 stop-instances'));
  assert.ok(!calls.includes('ssm wait command-executed'));
  assert.ok(!calls.includes('--force'));
});
void test('failed stop backup emits an explicit warning and still uses normal guest shutdown', () => {
  const directory = resolve('.context/control-test-' + randomUUID()),
    config = directory + '/control.json',
    log = directory + '/aws.log';
  mkdirSync(directory, { recursive: true });
  symlinkSync(resolve('tests/fixtures/mock-sandbox-aws.sh'), directory + '/aws');
  writeFileSync(
    config,
    JSON.stringify({
      aws_profile: 'confirmed-profile',
      expected_account_id: '000000000001',
      region: 'ap-northeast-1',
      instance_id: 'i-00000000000000001',
      web_url: 'https://test.cloudfront.net',
    }),
    { mode: 0o600 },
  );
  const result = spawnSync('bash', ['scripts/sandbox-control.sh', 'stop'], {
    env: {
      ...process.env,
      PATH: directory + ':' + process.env.PATH,
      REGI_SANDBOX_CONTROL_CONFIG: config,
      MOCK_AWS_LOG: log,
      MOCK_AWS_ACCOUNT: '000000000001',
      MOCK_SSM_FINAL_STATUS: 'Failed',
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0);
  assert.ok(result.stdout.includes('Stopped.'));
  assert.ok(result.stderr.includes('SSM shutdown or stop backup incomplete'));
  const calls = readFileSync(log, 'utf8');
  assert.ok(calls.includes('ec2 stop-instances'));
  assert.ok(!calls.includes('--force'));
});
test('secrets, private pins, plans/state are excluded; source examples remain included', () => {
  const paths = [
    'infra/sandbox/private.tfvars',
    'infra/sandbox/review.tfplan',
    'infra/sandbox/terraform.tfstate.backup',
    '.env.production',
    'scripts/private.pin',
    'docs/private.key',
    '.private/control.json',
  ];
  for (const path of paths)
    assert.ok(execFileSync('git', ['check-ignore', path], { encoding: 'utf8' }).trim() === path);
  for (const path of ['infra/sandbox/sandbox.tfvars.example', '.env.example'])
    assert.throws(() => execFileSync('git', ['check-ignore', path], { stdio: 'pipe' }));
  const dockerIgnore = readFileSync('.dockerignore', 'utf8');
  for (const pattern of [
    '**/*.tfvars',
    '**/*.tfstate*',
    '**/.env.*',
    '**/*.pin',
    '.private',
    '**/.aws',
  ])
    assert.ok(dockerIgnore.split('\n').includes(pattern));
});
