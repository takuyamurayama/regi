terraform {
  required_version = ">= 1.10.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
}
provider "aws" { region = "ap-northeast-1" }
data "aws_availability_zones" "available" { state = "available" }
data "aws_caller_identity" "current" {}
