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
  mock_resource "aws_sqs_queue" { defaults = { url = "https://sqs.ap-northeast-1.amazonaws.com/000000000001/test-sandbox", arn = "arn:aws:sqs:ap-northeast-1:000000000001:test-sandbox" } }
  mock_resource "aws_cognito_user_pool" { defaults = { id = "ap-northeast-1_Synthetic" } }
  mock_resource "aws_cognito_user_pool_client" { defaults = { id = "synthetic-client" } }
  mock_resource "aws_cloudfront_distribution" { defaults = { domain_name = "synthetic.cloudfront.net" } }
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
