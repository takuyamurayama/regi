output "deployment" {
  value = {
    expected_account_id = var.expected_account_id
    region              = "ap-northeast-1"
    instance_id         = aws_instance.host.id
    web_url             = "https://${aws_cloudfront_distribution.web.domain_name}"
    distribution_id     = aws_cloudfront_distribution.web.id
    user_pool_id        = aws_cognito_user_pool.staff.id
    client_id           = aws_cognito_user_pool_client.web.id
    android_client_id   = aws_cognito_user_pool_client.android.id
    cognito_domain      = "https://${aws_cognito_user_pool_domain.staff.domain}.auth.ap-northeast-1.amazoncognito.com"
    web_bucket          = aws_s3_bucket.web.id
    private_bucket      = aws_s3_bucket.private.id
    bootstrap_bucket    = var.bootstrap_bucket
    runtime_parameter   = aws_ssm_parameter.runtime.name
    persistent_volume   = aws_ebs_volume.data.id
    secret_arn          = aws_secretsmanager_secret.runtime.arn
    auto_stop_hours     = 2
    ai_enabled          = var.bedrock_profile_arn != ""
    require_mfa         = var.require_mfa
  }
}
