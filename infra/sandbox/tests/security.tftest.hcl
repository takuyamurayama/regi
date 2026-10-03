mock_provider "aws" {
  override_during = plan
  mock_data "aws_availability_zones" { defaults = { names = ["ap-northeast-1a", "ap-northeast-1c"], zone_ids = ["apne1-az4", "apne1-az1"] } }
  mock_data "aws_caller_identity" { defaults = { account_id = "000000000001" } }
  mock_data "aws_ami" { defaults = { id = "ami-00000000000000001" } }
  mock_resource "aws_iam_role" { defaults = { arn = "arn:aws:iam::000000000001:role/test-sandbox" } }
  mock_resource "aws_s3_bucket" { defaults = { id = "test-sandbox", arn = "arn:aws:s3:::test-sandbox", bucket_regional_domain_name = "test.s3.ap-northeast-1.amazonaws.com" } }
  mock_resource "aws_secretsmanager_secret" { defaults = { arn = "arn:aws:secretsmanager:ap-northeast-1:000000000001:secret:test-123456" } }
  mock_resource "aws_security_group" { defaults = { ingress = [] } }
  mock_resource "aws_instance" { defaults = { arn = "arn:aws:ec2:ap-northeast-1:000000000001:instance/i-00000000000000001", private_dns = "ip-10-63-0-10.ap-northeast-1.compute.internal" } }
  mock_resource "aws_ebs_volume" { defaults = { id = "vol-00000000000000001" } }
  mock_resource "aws_sqs_queue" { defaults = { url = "https://sqs.ap-northeast-1.amazonaws.com/000000000001/test-sandbox", arn = "arn:aws:sqs:ap-northeast-1:000000000001:test-sandbox" } }
  mock_resource "aws_cognito_user_pool" { defaults = { id = "ap-northeast-1_Synthetic" } }
  mock_resource "aws_cognito_user_pool_client" { defaults = { id = "synthetic-client" } }
  mock_resource "aws_cloudfront_distribution" { defaults = { domain_name = "synthetic.cloudfront.net" } }
  mock_resource "aws_cloudfront_function" { defaults = { arn = "arn:aws:cloudfront::000000000001:function/test-web-routes" } }
}
mock_provider "aws" {
  alias           = "osaka"
  override_during = plan
  mock_resource "aws_s3_bucket" {
    defaults = {
      id                          = "test-backups-osaka"
      arn                         = "arn:aws:s3:::test-backups-osaka"
      bucket_regional_domain_name = "test-backups-osaka.s3.ap-northeast-3.amazonaws.com"
    }
  }
}
override_resource {
  target          = aws_s3_bucket.backups
  override_during = plan
  values          = { id = "test-backups-tokyo", arn = "arn:aws:s3:::test-backups-tokyo" }
}
override_resource {
  target          = aws_iam_role.backup_replication
  override_during = plan
  values          = { arn = "arn:aws:iam::000000000001:role/test-backup-replication" }
}
override_resource {
  target          = aws_cognito_user_pool_client.android
  override_during = plan
  values          = { id = "synthetic-android-client" }
}
variables {
  expected_account_id = "000000000001"
  alert_email         = "sandbox@example.invalid"
  bootstrap_bucket    = "test-bootstrap"
}
run "private_domainless_ondemand_plan" {
  command = plan
  assert {
    condition     = aws_instance.host.instance_type == "t3a.small" && aws_instance.host.instance_initiated_shutdown_behavior == "stop" && one(aws_instance.host.credit_specification).cpu_credits == "standard"
    error_message = "Host must be small, stop (not terminate), and never use surplus CPU billing."
  }
  assert {
    condition     = length(aws_security_group.host.ingress) == 0 && aws_vpc_security_group_ingress_rule.cloudfront.from_port == 3000 && aws_vpc_security_group_ingress_rule.cloudfront.cidr_ipv4 == null
    error_message = "No world, SSH, DB or public API ingress. Only the CF service-managed security group may enter."
  }
  assert {
    condition     = one(aws_instance.host.root_block_device).encrypted && aws_ebs_volume.data.encrypted && one(aws_instance.host.root_block_device).volume_size + aws_ebs_volume.data.size == 40
    error_message = "All disks must be encrypted; OS plus persistent database storage total 40GB."
  }
  assert {
    condition     = aws_cognito_user_pool.staff.mfa_configuration == "ON" && one(aws_cognito_user_pool.staff.software_token_mfa_configuration).enabled && !aws_cognito_user_pool_client.web.generate_secret && !contains(aws_cognito_user_pool_client.web.write_attributes, "custom:tenant_id")
    error_message = "Cognito MFA and public PKCE client must not permit tenant claim updates."
  }
  assert {
    condition     = aws_cloudfront_distribution.web.default_cache_behavior[0].viewer_protocol_policy == "redirect-to-https" && one(aws_cloudfront_vpc_origin.api.vpc_origin_endpoint_config).origin_protocol_policy == "http-only"
    error_message = "Viewer HTTPS and private VPC origin (not public plaintext) are required."
  }
  assert {
    condition     = var.bedrock_profile_arn == "" && !var.demo.enabled && var.image_sha256 == ""
    error_message = "AI, synthetic seeding and unverified image execution must be opt-in."
  }
  assert {
    condition     = strcontains(aws_iam_role_policy.host.policy, "/state/*") && strcontains(aws_iam_role_policy.workload.policy, "secretsmanager:*") && !strcontains(aws_iam_role_policy.workload.policy, "bootstrap")
    error_message = "Host must be denied state access; application identities must not read owner secrets or releases."
  }
}
run "reject_unconfirmed_account" {
  command = plan
  variables { expected_account_id = "" }
  expect_failures = [var.expected_account_id]
}
run "separate_android_public_client" {
  command = plan
  assert {
    condition     = aws_cognito_user_pool_client.android.user_pool_id == aws_cognito_user_pool.staff.id && !aws_cognito_user_pool_client.android.generate_secret && aws_cognito_user_pool_client.android.allowed_oauth_flows_user_pool_client && toset(aws_cognito_user_pool_client.android.allowed_oauth_flows) == toset(["code"]) && toset(aws_cognito_user_pool_client.android.allowed_oauth_scopes) == toset(["openid", "profile"]) && toset(aws_cognito_user_pool_client.android.callback_urls) == toset(["regipos://oauth"])
    error_message = "Android must use its own public authorization-code client and exact PKCE callback."
  }
  assert {
    condition     = aws_cognito_user_pool_client.android.refresh_token_validity == 30 && one(aws_cognito_user_pool_client.android.token_validity_units).refresh_token == "days" && aws_cognito_user_pool_client.android.access_token_validity == 1 && aws_cognito_user_pool_client.android.id_token_validity == 1 && one(aws_cognito_user_pool_client.android.token_validity_units).access_token == "hours" && one(aws_cognito_user_pool_client.android.token_validity_units).id_token == "hours" && aws_cognito_user_pool_client.web.refresh_token_validity == 1 && one(aws_cognito_user_pool_client.web.token_validity_units).refresh_token == "days"
    error_message = "Android refresh lasts 30 days, ID/access tokens last one hour, and Web stays at one day."
  }
  assert {
    condition     = !contains(aws_cognito_user_pool_client.android.write_attributes, "custom:tenant_id") && toset(aws_cognito_user_pool_client.android.read_attributes) == toset(aws_cognito_user_pool_client.web.read_attributes) && aws_cognito_user_pool_client.android.prevent_user_existence_errors == "ENABLED"
    error_message = "Android must preserve immutable tenant claims and the existing Web attribute boundary."
  }
  assert {
    condition     = jsondecode(aws_ssm_parameter.runtime.value).androidClientId == "synthetic-android-client" && jsondecode(aws_ssm_parameter.runtime.value).clientId == "synthetic-client" && output.deployment.android_client_id == "synthetic-android-client" && output.deployment.client_id == "synthetic-client"
    error_message = "Distinct Web and Android client IDs must reach runtime and operator outputs."
  }
}
run "protected_hourly_postgres_backup_buckets" {
  command = plan
  assert {
    condition = (
      aws_s3_bucket.backups.id == "test-backups-tokyo" &&
      aws_s3_bucket.backups_replica.id == "test-backups-osaka" &&
      !aws_s3_bucket.backups.force_destroy &&
      !aws_s3_bucket.backups_replica.force_destroy
    )
    error_message = "Backups must use distinct Tokyo and Osaka buckets, with Osaka provider placement and no forced bucket deletion."
  }
  assert {
    condition = (
      alltrue([
        for block in [aws_s3_bucket_public_access_block.backups, aws_s3_bucket_public_access_block.backups_replica] :
        block.block_public_acls &&
        block.block_public_policy &&
        block.ignore_public_acls &&
        block.restrict_public_buckets
      ])
    )
    error_message = "Both backup regions must reject all public bucket and ACL access."
  }
  assert {
    condition = (
      aws_s3_bucket_public_access_block.backups.bucket == aws_s3_bucket.backups.id &&
      aws_s3_bucket_public_access_block.backups_replica.bucket == aws_s3_bucket.backups_replica.id &&
      aws_s3_bucket_versioning.backups.bucket == aws_s3_bucket.backups.id &&
      aws_s3_bucket_versioning.backups_replica.bucket == aws_s3_bucket.backups_replica.id &&
      one(aws_s3_bucket_versioning.backups.versioning_configuration).status == "Enabled" &&
      one(aws_s3_bucket_versioning.backups_replica.versioning_configuration).status == "Enabled"
    )
    error_message = "Public blocking and enabled versioning must apply independently to each actual backup bucket."
  }
  assert {
    condition = (
      aws_s3_bucket_ownership_controls.backups.bucket == aws_s3_bucket.backups.id &&
      aws_s3_bucket_ownership_controls.backups_replica.bucket == aws_s3_bucket.backups_replica.id &&
      one(aws_s3_bucket_ownership_controls.backups.rule).object_ownership == "BucketOwnerEnforced" &&
      one(aws_s3_bucket_ownership_controls.backups_replica.rule).object_ownership == "BucketOwnerEnforced" &&
      aws_s3_bucket_server_side_encryption_configuration.backups.bucket == aws_s3_bucket.backups.id &&
      aws_s3_bucket_server_side_encryption_configuration.backups_replica.bucket == aws_s3_bucket.backups_replica.id &&
      alltrue([
        for encryption in [aws_s3_bucket_server_side_encryption_configuration.backups, aws_s3_bucket_server_side_encryption_configuration.backups_replica] :
        one(one(encryption.rule).apply_server_side_encryption_by_default).sse_algorithm == "AES256"
      ])
    )
    error_message = "Each backup bucket must enforce bucket ownership and SSE-S3 AES256 without requiring a KMS key."
  }
  assert {
    condition = (
      aws_s3_bucket_policy.backups.bucket == aws_s3_bucket.backups.id &&
      aws_s3_bucket_policy.backups_replica.bucket == aws_s3_bucket.backups_replica.id &&
      alltrue([
        for pair in [{ policy = aws_s3_bucket_policy.backups.policy, arn = aws_s3_bucket.backups.arn }, { policy = aws_s3_bucket_policy.backups_replica.policy, arn = aws_s3_bucket.backups_replica.arn }] :
        length(jsondecode(pair.policy).Statement) == 1 &&
        one(jsondecode(pair.policy).Statement).Effect == "Deny" &&
        one(jsondecode(pair.policy).Statement).Principal == "*" &&
        one(jsondecode(pair.policy).Statement).Action == "s3:*" &&
        toset(one(jsondecode(pair.policy).Statement).Resource) == toset([pair.arn, "${pair.arn}/*"]) &&
        jsonencode(one(jsondecode(pair.policy).Statement).Condition) == jsonencode({ Bool = { "aws:SecureTransport" = "false", "aws:PrincipalIsAWSService" = "false" } })
      ])
    )
    error_message = "TLS denial must be bucket-scoped with normal Bool SecureTransport=false AND PrincipalIsAWSService=false, preserving AWS service context."
  }
  assert {
    condition = (
      aws_s3_bucket_lifecycle_configuration.backups.bucket == aws_s3_bucket.backups.id &&
      aws_s3_bucket_lifecycle_configuration.backups_replica.bucket == aws_s3_bucket.backups_replica.id &&
      alltrue([
        for configuration in [aws_s3_bucket_lifecycle_configuration.backups, aws_s3_bucket_lifecycle_configuration.backups_replica] :
        length(configuration.rule) == 3 &&
        alltrue([
          for rule in configuration.rule : rule.status == "Enabled" &&
          one(rule.filter).prefix == "pg/"
        ]) &&
        one([for rule in configuration.rule : one(rule.expiration).days if rule.id == "expire-postgres-backups"]) == 35 &&
        one([for rule in configuration.rule : one(rule.noncurrent_version_expiration).noncurrent_days if rule.id == "expire-postgres-backups"]) == 35 &&
        one([for rule in configuration.rule : one(rule.abort_incomplete_multipart_upload).days_after_initiation if rule.id == "abort-incomplete-postgres-uploads"]) == 1 &&
        one([for rule in configuration.rule : one(rule.expiration).expired_object_delete_marker if rule.id == "remove-expired-postgres-delete-markers"])
      ])
    )
    error_message = "Both regions need pg/ current35/noncurrent35 expiration, one-day multipart cleanup and a separate expired-delete-marker rule."
  }
  assert {
    condition = (
      jsondecode(aws_ssm_parameter.runtime.value).backupBucket == aws_s3_bucket.backups.id &&
      jsondecode(aws_ssm_parameter.runtime.value).backupRegion == "ap-northeast-1" &&
      jsondecode(aws_ssm_parameter.runtime.value).backupReplicaBucket == aws_s3_bucket.backups_replica.id &&
      jsondecode(aws_ssm_parameter.runtime.value).backupReplicaRegion == "ap-northeast-3" &&
      output.deployment.backup_bucket == aws_s3_bucket.backups.id &&
      output.deployment.backup_region == "ap-northeast-1" &&
      output.deployment.backup_replica_bucket == aws_s3_bucket.backups_replica.id &&
      output.deployment.backup_replica_region == "ap-northeast-3"
    )
    error_message = "Runtime and operator outputs must identify the actual Tokyo backup and Osaka replica buckets and regions."
  }
}
run "least_privilege_postgres_replication" {
  command = plan
  assert {
    condition = (
      jsondecode(aws_iam_role.backup_replication.assume_role_policy).Statement == [{ Effect = "Allow", Principal = { Service = "s3.amazonaws.com" }, Action = "sts:AssumeRole" }]
    )
    error_message = "Only the S3 service may assume the live backup replication role."
  }
  assert {
    condition = (
      length(jsondecode(aws_iam_role_policy.backup_replication.policy).Statement) == 3 &&
      alltrue([for statement in jsondecode(aws_iam_role_policy.backup_replication.policy).Statement : statement.Effect == "Allow"]) &&
      toset(one([for statement in jsondecode(aws_iam_role_policy.backup_replication.policy).Statement : statement.Action if statement.Sid == "ReadSourceReplication"])) == toset(["s3:GetReplicationConfiguration", "s3:ListBucket"]) &&
      one([for statement in jsondecode(aws_iam_role_policy.backup_replication.policy).Statement : statement.Resource if statement.Sid == "ReadSourceReplication"]) == aws_s3_bucket.backups.arn &&
      toset(one([for statement in jsondecode(aws_iam_role_policy.backup_replication.policy).Statement : statement.Action if statement.Sid == "ReadPostgresVersions"])) == toset(["s3:GetObjectVersionForReplication", "s3:GetObjectVersionAcl"]) &&
      one([for statement in jsondecode(aws_iam_role_policy.backup_replication.policy).Statement : statement.Resource if statement.Sid == "ReadPostgresVersions"]) == "${aws_s3_bucket.backups.arn}/pg/*" &&
      one([for statement in jsondecode(aws_iam_role_policy.backup_replication.policy).Statement : statement.Action if statement.Sid == "ReplicatePostgresVersions"]) == ["s3:ReplicateObject"] &&
      one([for statement in jsondecode(aws_iam_role_policy.backup_replication.policy).Statement : statement.Resource if statement.Sid == "ReplicatePostgresVersions"]) == "${aws_s3_bucket.backups_replica.arn}/pg/*"
    )
    error_message = "Replication must read only source bucket configuration/pg versions and replicate pg objects to Osaka, without deletion, tagging, KMS or broad S3 permissions."
  }
  assert {
    condition = (
      aws_s3_bucket_replication_configuration.backups.bucket == aws_s3_bucket.backups.id &&
      aws_s3_bucket_replication_configuration.backups.role == aws_iam_role.backup_replication.arn &&
      length(aws_s3_bucket_replication_configuration.backups.rule) == 1 &&
      one(aws_s3_bucket_replication_configuration.backups.rule).status == "Enabled" &&
      one(one(aws_s3_bucket_replication_configuration.backups.rule).filter).prefix == "pg/" &&
      one(one(aws_s3_bucket_replication_configuration.backups.rule).delete_marker_replication).status == "Disabled" &&
      one(one(aws_s3_bucket_replication_configuration.backups.rule).destination).bucket == aws_s3_bucket.backups_replica.arn &&
      one(one(aws_s3_bucket_replication_configuration.backups.rule).destination).storage_class == "STANDARD"
    )
    error_message = "Live replication must use the restricted role and pg/ prefix to Osaka Standard, without propagating deletion markers."
  }
  assert {
    condition = (
      length([for statement in jsondecode(aws_iam_role_policy.host.policy).Statement : statement if try(statement.Sid, "") == "WritePostgresBackups"]) == 1 &&
      one([for statement in jsondecode(aws_iam_role_policy.host.policy).Statement : statement if try(statement.Sid, "") == "WritePostgresBackups"]).Effect == "Allow" &&
      one([for statement in jsondecode(aws_iam_role_policy.host.policy).Statement : statement if try(statement.Sid, "") == "WritePostgresBackups"]).Action == ["s3:PutObject"] &&
      one([for statement in jsondecode(aws_iam_role_policy.host.policy).Statement : statement if try(statement.Sid, "") == "WritePostgresBackups"]).Resource == "${aws_s3_bucket.backups.arn}/pg/*" &&
      length([for statement in jsondecode(aws_iam_role_policy.host.policy).Statement : statement if strcontains(jsonencode(statement), aws_s3_bucket.backups.arn) || strcontains(jsonencode(statement), aws_s3_bucket.backups_replica.arn)]) == 1 &&
      !strcontains(aws_iam_role_policy.workload.policy, aws_s3_bucket.backups.arn) &&
      !strcontains(aws_iam_role_policy.workload.policy, aws_s3_bucket.backups_replica.arn)
    )
    error_message = "The host may only PutObject under Tokyo pg/; it must not read/list/delete backups or write replicas, and the application must have no backup access."
  }
  assert {
    condition = alltrue([
      for statement in jsondecode(aws_iam_role_policy.host.policy).Statement :
      (statement.Action == ["s3:GetObject"] && statement.Resource == "arn:aws:s3:::${var.bootstrap_bucket}/releases/*") ||
      (statement.Action == ["s3:PutObject"] && statement.Resource == "${aws_s3_bucket.backups.arn}/pg/*")
      if statement.Effect == "Allow" && anytrue([for action in statement.Action : startswith(action, "s3:") || action == "*"])
      ]) && alltrue([
      for statement in jsondecode(aws_iam_role_policy.workload.policy).Statement :
      toset(statement.Action) == toset(["s3:PutObject", "s3:GetObject"]) && statement.Resource == "${aws_s3_bucket.private.arn}/*"
      if statement.Effect == "Allow" && anytrue([for action in statement.Action : startswith(action, "s3:") || action == "*"])
    ])
    error_message = "A separate wildcard S3 Allow must not bypass host PutObject-only backups or grant the application backup access."
  }
}
run "verified_bootstrap_cognito_protection_and_budget" {
  command = plan
  assert {
    condition = (
      toset(keys(aws_s3_object.bootstrap)) == toset(["bootstrap.sh", "bootstrap.py", "credentials.py", "compose.yaml", "backup.sh", "restore.sh", "database_backup.py", "install-host.sh", "install_host.py", "regi-stop.sh", "regi.service", "regi-backup.service", "regi-backup.timer"]) &&
      toset(keys(jsondecode(aws_ssm_parameter.runtime.value).bootstrapSha256)) == toset(keys(aws_s3_object.bootstrap)) &&
      alltrue([
        for key, object in aws_s3_object.bootstrap : object.key == "releases/${var.name}/bootstrap/${key}" &&
        jsondecode(aws_ssm_parameter.runtime.value).bootstrapSha256[key] == filesha256("${path.module}/host/${key}") &&
        strcontains(aws_instance.host.user_data, filesha256("${path.module}/host/${key}"))
      ])
    )
    error_message = "All thirteen bootstrap files must have exact release keys and current SHA256 values in both runtime and initial userdata for verified host updates."
  }
  assert {
    condition = (
      aws_cognito_user_pool.staff.deletion_protection == "ACTIVE"
    )
    error_message = "Cognito must reject user-pool deletion; Terraform prevent_destroy is also reviewed independently."
  }
  assert {
    condition = (
      aws_budgets_budget.monthly.limit_amount == "10" &&
      aws_budgets_budget.monthly.limit_unit == "USD" &&
      aws_budgets_budget.monthly.budget_type == "COST" &&
      aws_budgets_budget.monthly.time_unit == "MONTHLY" &&
      length(aws_budgets_budget.monthly.cost_filter) == 0 &&
      length(aws_budgets_budget.monthly.notification) == 2 &&
      alltrue([
        for notification in aws_budgets_budget.monthly.notification : notification.comparison_operator == "GREATER_THAN" &&
        notification.threshold_type == "PERCENTAGE" &&
        toset(notification.subscriber_email_addresses) == toset([var.alert_email]) &&
        (notification.notification_type == "ACTUAL" &&
          notification.threshold == 80 || notification.notification_type == "FORECASTED" &&
        notification.threshold == 100)
      ])
    )
    error_message = "Default account-wide Budget10USD must notify ACTUAL80% and FORECASTED100%; it is not a spending cap."
  }
}
run "reject_seed_without_actual_subject" {
  command = plan
  variables { demo = { enabled = true, tenant_id = "", administrator_subject = "local-admin", end_day = "2026-10-01" } }
  expect_failures = [var.demo]
}
run "reject_unsafe_release_key" {
  command = plan
  variables { image_object_key = "state/regi-sandbox.tfstate" }
  expect_failures = [var.image_object_key]
}
run "password_only_requires_explicit_synthetic_sandbox" {
  command = plan
  variables { require_mfa = false }
  expect_failures = [var.require_mfa]
}
run "explicit_synthetic_password_only" {
  command = plan
  variables {
    require_mfa = false
    demo        = { enabled = true, tenant_id = "00000000-0000-4000-8000-000000000001", administrator_subject = "18d5ac1f-4b28-70b6-65d0-94af2d71820a", end_day = "2026-10-01" }
  }
  assert {
    condition     = aws_cognito_user_pool.staff.mfa_configuration == "OFF" && length(aws_cognito_user_pool.staff.software_token_mfa_configuration) == 0 && !jsondecode(aws_ssm_parameter.runtime.value).requireMfa && !output.deployment.require_mfa
    error_message = "Explicit password-only must be OFF with no software-token block, matching host/runtime/output."
  }
  assert {
    condition     = !aws_cognito_user_pool_client.web.generate_secret && contains(aws_cognito_user_pool_client.web.allowed_oauth_flows, "code") && !contains(aws_cognito_user_pool_client.web.write_attributes, "custom:tenant_id")
    error_message = "Password-only must retain public PKCE authorization code and immutable tenant identity."
  }
}

run "web_routes_rewrite_only_the_default_web_behavior" {
  command = plan
  assert {
    condition     = aws_cloudfront_function.web_routes.runtime == "cloudfront-js-2.0" && aws_cloudfront_function.web_routes.publish && aws_cloudfront_function.web_routes.code == file("${path.module}/web-route-rewrite.js")
    error_message = "Deploy exactly the tested web route function."
  }
  assert {
    condition     = one(aws_cloudfront_distribution.web.default_cache_behavior).target_origin_id == "web" && one(one(aws_cloudfront_distribution.web.default_cache_behavior).function_association).event_type == "viewer-request" && one(one(aws_cloudfront_distribution.web.default_cache_behavior).function_association).function_arn == aws_cloudfront_function.web_routes.arn
    error_message = "Attach the rewrite only to the default web behavior."
  }
  assert {
    condition     = alltrue([for behavior in aws_cloudfront_distribution.web.ordered_cache_behavior : behavior.target_origin_id == "api" && length(behavior.function_association) == 0]) && length(aws_cloudfront_distribution.web.custom_error_response) == 0
    error_message = "API/health errors must retain their HTTP status and body rather than become HTML 200."
  }
}
