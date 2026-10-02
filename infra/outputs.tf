output "database_endpoint" {
  value = aws_db_instance.main.endpoint
}

output "database_master_secret" {
  value = aws_db_instance.main.master_user_secret[0].secret_arn
}

output "web_url" {
  value = "https://${aws_cloudfront_distribution.web.domain_name}"
}

output "alb_dns" {
  value = aws_lb.api.dns_name
}

output "user_pool_id" {
  value = aws_cognito_user_pool.staff.id
}

output "client_id" {
  value = aws_cognito_user_pool_client.web.id
}

output "artifacts_bucket" {
  value = aws_s3_bucket.artifacts.id
}

output "web_bucket" {
  value = aws_s3_bucket.web.id
}
