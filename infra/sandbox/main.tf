locals {
  az           = data.aws_availability_zones.available.names[0]
  runtime_path = "/${var.name}/runtime"
  bootstrap_keys = toset([
    "bootstrap.sh", "bootstrap.py", "credentials.py", "compose.yaml",
    "backup.sh", "restore.sh", "database_backup.py", "install-host.sh", "install_host.py",
    "regi-stop.sh", "regi.service", "regi-backup.service", "regi-backup.timer"
  ])
  bootstrap_checksums = { for key in local.bootstrap_keys : key => filesha256("${path.module}/host/${key}") }
  assume_ec2          = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Service = "ec2.amazonaws.com" }, Action = "sts:AssumeRole" }] })
}
resource "aws_vpc" "main" {
  cidr_block           = "10.63.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true
}
resource "aws_internet_gateway" "main" { vpc_id = aws_vpc.main.id }
resource "aws_subnet" "host" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.63.0.0/24"
  availability_zone       = local.az
  map_public_ip_on_launch = false
}
resource "aws_subnet" "private" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.63.10.0/24"
  availability_zone = local.az
}
resource "aws_route_table" "egress" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }
}
resource "aws_route_table_association" "host" {
  subnet_id      = aws_subnet.host.id
  route_table_id = aws_route_table.egress.id
}
resource "aws_security_group" "host" {
  name_prefix = "${var.name}-host-"
  vpc_id      = aws_vpc.main.id
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}
resource "aws_s3_bucket" "web" { bucket_prefix = "${var.name}-web-" }
resource "aws_s3_bucket" "private" { bucket_prefix = "${var.name}-private-" }
resource "aws_s3_bucket_public_access_block" "all" {
  for_each                = { web = aws_s3_bucket.web.id, private = aws_s3_bucket.private.id }
  bucket                  = each.value
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_server_side_encryption_configuration" "all" {
  for_each = { web = aws_s3_bucket.web.id, private = aws_s3_bucket.private.id }
  bucket   = each.value
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}
resource "aws_s3_bucket_versioning" "private" {
  bucket = aws_s3_bucket.private.id
  versioning_configuration { status = "Enabled" }
}
resource "aws_s3_bucket" "backups" {
  bucket_prefix = "${var.name}-backups-"
  force_destroy = false
  lifecycle { prevent_destroy = true }
}
resource "aws_s3_bucket" "backups_replica" {
  provider      = aws.osaka
  bucket_prefix = "${var.name}-backups-osaka-"
  force_destroy = false
  lifecycle { prevent_destroy = true }
}
resource "aws_s3_bucket_public_access_block" "backups" {
  bucket                  = aws_s3_bucket.backups.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_public_access_block" "backups_replica" {
  provider                = aws.osaka
  bucket                  = aws_s3_bucket.backups_replica.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_ownership_controls" "backups" {
  bucket = aws_s3_bucket.backups.id
  rule { object_ownership = "BucketOwnerEnforced" }
}
resource "aws_s3_bucket_ownership_controls" "backups_replica" {
  provider = aws.osaka
  bucket   = aws_s3_bucket.backups_replica.id
  rule { object_ownership = "BucketOwnerEnforced" }
}
resource "aws_s3_bucket_server_side_encryption_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}
resource "aws_s3_bucket_server_side_encryption_configuration" "backups_replica" {
  provider = aws.osaka
  bucket   = aws_s3_bucket.backups_replica.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}
resource "aws_s3_bucket_versioning" "backups" {
  bucket = aws_s3_bucket.backups.id
  versioning_configuration { status = "Enabled" }
}
resource "aws_s3_bucket_versioning" "backups_replica" {
  provider = aws.osaka
  bucket   = aws_s3_bucket.backups_replica.id
  versioning_configuration { status = "Enabled" }
}
resource "aws_s3_bucket_policy" "backups" {
  bucket = aws_s3_bucket.backups.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Sid       = "DenyNonTLS", Effect = "Deny", Principal = "*", Action = "s3:*",
    Resource  = [aws_s3_bucket.backups.arn, "${aws_s3_bucket.backups.arn}/*"],
    Condition = { Bool = { "aws:SecureTransport" = "false", "aws:PrincipalIsAWSService" = "false" } }
  }] })
}
resource "aws_s3_bucket_policy" "backups_replica" {
  provider = aws.osaka
  bucket   = aws_s3_bucket.backups_replica.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Sid       = "DenyNonTLS", Effect = "Deny", Principal = "*", Action = "s3:*",
    Resource  = [aws_s3_bucket.backups_replica.arn, "${aws_s3_bucket.backups_replica.arn}/*"],
    Condition = { Bool = { "aws:SecureTransport" = "false", "aws:PrincipalIsAWSService" = "false" } }
  }] })
}
resource "aws_s3_bucket_lifecycle_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id
  rule {
    id     = "expire-postgres-backups"
    status = "Enabled"
    filter { prefix = "pg/" }
    expiration { days = 35 }
    noncurrent_version_expiration { noncurrent_days = 35 }
  }
  rule {
    id     = "abort-incomplete-postgres-uploads"
    status = "Enabled"
    filter { prefix = "pg/" }
    abort_incomplete_multipart_upload { days_after_initiation = 1 }
  }
  rule {
    id     = "remove-expired-postgres-delete-markers"
    status = "Enabled"
    filter { prefix = "pg/" }
    expiration { expired_object_delete_marker = true }
  }
  depends_on = [aws_s3_bucket_versioning.backups]
}
resource "aws_s3_bucket_lifecycle_configuration" "backups_replica" {
  provider = aws.osaka
  bucket   = aws_s3_bucket.backups_replica.id
  rule {
    id     = "expire-postgres-backups"
    status = "Enabled"
    filter { prefix = "pg/" }
    expiration { days = 35 }
    noncurrent_version_expiration { noncurrent_days = 35 }
  }
  rule {
    id     = "abort-incomplete-postgres-uploads"
    status = "Enabled"
    filter { prefix = "pg/" }
    abort_incomplete_multipart_upload { days_after_initiation = 1 }
  }
  rule {
    id     = "remove-expired-postgres-delete-markers"
    status = "Enabled"
    filter { prefix = "pg/" }
    expiration { expired_object_delete_marker = true }
  }
  depends_on = [aws_s3_bucket_versioning.backups_replica]
}
resource "aws_iam_role" "backup_replication" {
  name_prefix = "${var.name}-backup-replication-"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect = "Allow", Principal = { Service = "s3.amazonaws.com" }, Action = "sts:AssumeRole"
  }] })
}
resource "aws_iam_role_policy" "backup_replication" {
  role = aws_iam_role.backup_replication.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Sid = "ReadSourceReplication", Effect = "Allow", Action = ["s3:GetReplicationConfiguration", "s3:ListBucket"], Resource = aws_s3_bucket.backups.arn },
    { Sid = "ReadPostgresVersions", Effect = "Allow", Action = ["s3:GetObjectVersionForReplication", "s3:GetObjectVersionAcl"], Resource = "${aws_s3_bucket.backups.arn}/pg/*" },
    { Sid = "ReplicatePostgresVersions", Effect = "Allow", Action = ["s3:ReplicateObject"], Resource = "${aws_s3_bucket.backups_replica.arn}/pg/*" }
  ] })
}
resource "aws_s3_bucket_replication_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id
  role   = aws_iam_role.backup_replication.arn
  rule {
    id       = "postgres-to-osaka"
    status   = "Enabled"
    priority = 1
    filter { prefix = "pg/" }
    delete_marker_replication { status = "Disabled" }
    destination {
      bucket        = aws_s3_bucket.backups_replica.arn
      storage_class = "STANDARD"
    }
  }
  depends_on = [
    aws_s3_bucket_versioning.backups, aws_s3_bucket_versioning.backups_replica,
    aws_s3_bucket_public_access_block.backups, aws_s3_bucket_public_access_block.backups_replica,
    aws_s3_bucket_ownership_controls.backups, aws_s3_bucket_ownership_controls.backups_replica,
    aws_s3_bucket_server_side_encryption_configuration.backups, aws_s3_bucket_server_side_encryption_configuration.backups_replica,
    aws_s3_bucket_policy.backups, aws_s3_bucket_policy.backups_replica,
    aws_iam_role_policy.backup_replication
  ]
}
resource "aws_s3_object" "bootstrap" {
  for_each     = local.bootstrap_keys
  bucket       = var.bootstrap_bucket
  key          = "releases/${var.name}/bootstrap/${each.key}"
  source       = "${path.module}/host/${each.key}"
  source_hash  = filemd5("${path.module}/host/${each.key}")
  content_type = "application/octet-stream"
}
resource "aws_secretsmanager_secret" "runtime" { name_prefix = "${var.name}-runtime-" }
resource "aws_iam_role" "host" {
  name_prefix        = "${var.name}-host-"
  assume_role_policy = local.assume_ec2
}
resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.host.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}
resource "aws_iam_instance_profile" "host" { role = aws_iam_role.host.name }
resource "aws_iam_role" "workload" {
  name_prefix        = "${var.name}-workload-"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { AWS = aws_iam_role.host.arn }, Action = "sts:AssumeRole" }] })
}
resource "aws_iam_role_policy" "host" {
  role = aws_iam_role.host.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["s3:GetObject"], Resource = "arn:aws:s3:::${var.bootstrap_bucket}/releases/*" },
    { Sid = "WritePostgresBackups", Effect = "Allow", Action = ["s3:PutObject"], Resource = "${aws_s3_bucket.backups.arn}/pg/*" },
    { Effect = "Deny", Action = ["s3:*"], Resource = "arn:aws:s3:::${var.bootstrap_bucket}/state/*" },
    { Effect = "Allow", Action = ["ssm:GetParameter"], Resource = "arn:aws:ssm:ap-northeast-1:${var.expected_account_id}:parameter${local.runtime_path}" },
    { Effect = "Allow", Action = ["secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue"], Resource = aws_secretsmanager_secret.runtime.arn },
    { Effect = "Allow", Action = ["sts:AssumeRole"], Resource = aws_iam_role.workload.arn }
  ] })
}
resource "aws_sqs_queue" "dead" {
  name                      = "${var.name}-exports-dead"
  sqs_managed_sse_enabled   = true
  message_retention_seconds = 1209600
}
resource "aws_sqs_queue" "exports" {
  name                       = "${var.name}-exports"
  sqs_managed_sse_enabled    = true
  visibility_timeout_seconds = 120
  redrive_policy             = jsonencode({ deadLetterTargetArn = aws_sqs_queue.dead.arn, maxReceiveCount = 5 })
}
resource "aws_iam_role_policy" "workload" {
  role = aws_iam_role.workload.id
  policy = jsonencode({ Version = "2012-10-17", Statement = concat([
    { Effect = "Deny", Action = ["secretsmanager:*"], Resource = "*" },
    { Effect = "Allow", Action = ["s3:PutObject", "s3:GetObject"], Resource = "${aws_s3_bucket.private.arn}/*" },
    { Effect = "Allow", Action = ["sqs:SendMessage", "sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"], Resource = aws_sqs_queue.exports.arn }
  ], var.bedrock_profile_arn == "" ? [] : [{ Effect = "Allow", Action = ["bedrock:InvokeModel"], Resource = [var.bedrock_profile_arn, "arn:aws:bedrock:ap-northeast-1::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0", "arn:aws:bedrock:ap-northeast-3::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0"] }]) })
}
resource "aws_instance" "host" {
  ami                                  = data.aws_ami.linux.id
  instance_type                        = "t3a.small"
  subnet_id                            = aws_subnet.host.id
  associate_public_ip_address          = true
  vpc_security_group_ids               = [aws_security_group.host.id]
  iam_instance_profile                 = aws_iam_instance_profile.host.name
  instance_initiated_shutdown_behavior = "stop"
  user_data_replace_on_change          = false
  credit_specification { cpu_credits = "standard" }
  root_block_device {
    volume_size = 8
    volume_type = "gp3"
    encrypted   = true
  }
  metadata_options {
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }
  user_data  = templatefile("${path.module}/host/user-data.sh.tftpl", { bucket = var.bootstrap_bucket, runtime_path = local.runtime_path, secret_arn = aws_secretsmanager_secret.runtime.arn, name = var.name, volume_id = aws_ebs_volume.data.id, bootstrap_checksums = jsonencode(local.bootstrap_checksums) })
  depends_on = [aws_route_table_association.host, aws_iam_role_policy.host, aws_s3_object.bootstrap]
  tags       = { Name = var.name }
}
resource "aws_ebs_volume" "data" {
  availability_zone = local.az
  size              = 32
  type              = "gp3"
  encrypted         = true
  lifecycle { prevent_destroy = true }
  tags = { Name = "${var.name}-persistent-demo-db" }
}
resource "aws_volume_attachment" "data" {
  device_name = "/dev/sdf"
  volume_id   = aws_ebs_volume.data.id
  instance_id = aws_instance.host.id
}
resource "aws_cloudfront_vpc_origin" "api" {
  vpc_origin_endpoint_config {
    name                   = var.name
    arn                    = aws_instance.host.arn
    http_port              = 3000
    https_port             = 443
    origin_protocol_policy = "http-only"
    origin_ssl_protocols {
      items    = ["TLSv1.2"]
      quantity = 1
    }
  }
  depends_on = [aws_internet_gateway.main]
}
data "aws_security_group" "cloudfront" {
  filter {
    name   = "vpc-id"
    values = [aws_vpc.main.id]
  }
  filter {
    name   = "group-name"
    values = ["CloudFront-VPCOrigins-Service-SG"]
  }
  depends_on = [aws_cloudfront_vpc_origin.api]
}
resource "aws_vpc_security_group_ingress_rule" "cloudfront" {
  security_group_id            = aws_security_group.host.id
  referenced_security_group_id = data.aws_security_group.cloudfront.id
  from_port                    = 3000
  to_port                      = 3000
  ip_protocol                  = "tcp"
}
resource "aws_cloudfront_origin_access_control" "web" {
  name                              = var.name
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}
resource "aws_cloudfront_function" "web_routes" {
  name    = "${var.name}-web-routes"
  runtime = "cloudfront-js-2.0"
  comment = "Serve canonical REGI UI paths from the web origin; leave API and files untouched."
  publish = true
  code    = file("${path.module}/web-route-rewrite.js")
}
resource "aws_cloudfront_distribution" "web" {
  enabled             = true
  default_root_object = "index.html"
  price_class         = "PriceClass_200"
  origin {
    domain_name              = aws_s3_bucket.web.bucket_regional_domain_name
    origin_id                = "web"
    origin_access_control_id = aws_cloudfront_origin_access_control.web.id
  }
  origin {
    domain_name = aws_instance.host.private_dns
    origin_id   = "api"
    vpc_origin_config { vpc_origin_id = aws_cloudfront_vpc_origin.api.id }
  }
  default_cache_behavior {
    target_origin_id       = "web"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    viewer_protocol_policy = "redirect-to-https"
    cache_policy_id        = "658327ea-f89d-4fab-a63d-7e88639e58f6"
    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.web_routes.arn
    }
  }
  dynamic "ordered_cache_behavior" {
    for_each = ["/v1/*", "/health"]
    content {
      path_pattern             = ordered_cache_behavior.value
      target_origin_id         = "api"
      allowed_methods          = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
      cached_methods           = ["GET", "HEAD"]
      viewer_protocol_policy   = "https-only"
      cache_policy_id          = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
      origin_request_policy_id = "b689b0a8-53d0-40ab-baf2-68738e2966ac"
    }
  }
  restrictions {
    geo_restriction { restriction_type = "none" }
  }
  viewer_certificate { cloudfront_default_certificate = true }
}
resource "aws_s3_bucket_policy" "web" {
  bucket = aws_s3_bucket.web.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Service = "cloudfront.amazonaws.com" }, Action = "s3:GetObject", Resource = "${aws_s3_bucket.web.arn}/*", Condition = { StringEquals = { "AWS:SourceArn" = aws_cloudfront_distribution.web.arn } } }] })
}
resource "aws_cognito_user_pool" "staff" {
  name                = var.name
  deletion_protection = "ACTIVE"
  mfa_configuration   = var.require_mfa ? "ON" : "OFF"
  lifecycle { prevent_destroy = true }
  dynamic "software_token_mfa_configuration" {
    for_each = var.require_mfa ? [true] : []
    content {
      enabled = true
    }
  }
  admin_create_user_config { allow_admin_create_user_only = true }
  password_policy {
    minimum_length    = 14
    require_lowercase = true
    require_uppercase = true
    require_numbers   = true
    require_symbols   = true
  }
  schema {
    name                = "tenant_id"
    attribute_data_type = "String"
    mutable             = false
    required            = false
    string_attribute_constraints {
      min_length = 36
      max_length = 36
    }
  }
}
resource "aws_cognito_user_pool_client" "web" {
  name                                 = "${var.name}-web"
  user_pool_id                         = aws_cognito_user_pool.staff.id
  generate_secret                      = false
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "profile"]
  supported_identity_providers         = ["COGNITO"]
  callback_urls                        = ["https://${aws_cloudfront_distribution.web.domain_name}/"]
  logout_urls                          = ["https://${aws_cloudfront_distribution.web.domain_name}/"]
  read_attributes                      = ["custom:tenant_id", "email", "email_verified"]
  write_attributes                     = ["email"]
  prevent_user_existence_errors        = "ENABLED"
  access_token_validity                = 1
  id_token_validity                    = 1
  refresh_token_validity               = 1
  token_validity_units {
    access_token  = "hours"
    id_token      = "hours"
    refresh_token = "days"
  }
}
resource "aws_cognito_user_pool_domain" "staff" {
  domain       = "${var.name}-${var.expected_account_id}"
  user_pool_id = aws_cognito_user_pool.staff.id
}
resource "aws_cognito_user_pool_client" "android" {
  name                                 = "${var.name}-android"
  user_pool_id                         = aws_cognito_user_pool.staff.id
  generate_secret                      = false
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "profile"]
  supported_identity_providers         = ["COGNITO"]
  callback_urls                        = ["regipos://oauth"]
  read_attributes                      = ["custom:tenant_id", "email", "email_verified"]
  write_attributes                     = ["email"]
  prevent_user_existence_errors        = "ENABLED"
  access_token_validity                = 1
  id_token_validity                    = 1
  refresh_token_validity               = 30
  token_validity_units {
    access_token  = "hours"
    id_token      = "hours"
    refresh_token = "days"
  }
}
resource "aws_ssm_parameter" "runtime" {
  name = local.runtime_path
  type = "String"
  value = jsonencode({
    name         = var.name, issuer = "https://cognito-idp.ap-northeast-1.amazonaws.com/${aws_cognito_user_pool.staff.id}", clientId = aws_cognito_user_pool_client.web.id, androidClientId = aws_cognito_user_pool_client.android.id,
    webOrigin    = "https://${aws_cloudfront_distribution.web.domain_name}", workloadRoleArn = aws_iam_role.workload.arn, bucket = aws_s3_bucket.private.id,
    queueUrl     = aws_sqs_queue.exports.url, releaseBucket = var.bootstrap_bucket, imageObjectKey = var.image_object_key, imageSha256 = var.image_sha256, image = "regi:sandbox", demo = var.demo, bedrockProfileArn = var.bedrock_profile_arn, requireMfa = var.require_mfa,
    backupBucket = aws_s3_bucket.backups.id, backupRegion = "ap-northeast-1", backupReplicaBucket = aws_s3_bucket.backups_replica.id, backupReplicaRegion = "ap-northeast-3", bootstrapSha256 = local.bootstrap_checksums
  })
  depends_on = [aws_s3_bucket_replication_configuration.backups, aws_s3_bucket_lifecycle_configuration.backups, aws_s3_bucket_lifecycle_configuration.backups_replica]
}
resource "aws_budgets_budget" "monthly" {
  name         = "${var.name}-account-monthly-alert"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.alert_email]
  }
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.alert_email]
  }
}
