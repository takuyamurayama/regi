terraform {
  required_version = ">= 1.10.0"
  backend "s3" {}
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
}
provider "aws" {
  region              = "ap-northeast-1"
  allowed_account_ids = [var.expected_account_id]
  default_tags { tags = { Project = var.name, Environment = "personal-sandbox", SyntheticDataOnly = "true" } }
}
data "aws_caller_identity" "current" {}
data "aws_availability_zones" "available" {
  state            = "available"
  exclude_zone_ids = ["apne1-az3"]
}
data "aws_ami" "linux" {
  most_recent = true
  owners      = ["amazon"]
  filter {
    name   = "name"
    values = ["al2023-ami-2023.*-x86_64"]
  }
  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}
