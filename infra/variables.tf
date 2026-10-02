variable "name" {
  type    = string
  default = "regi"
}

variable "image" {
  type = string
}

variable "api_domain" {
  type = string
}

variable "certificate_arn" {
  type = string
}

variable "callback_urls" {
  type = list(string)
}

variable "app_database_url" {
  type      = string
  sensitive = true
}

variable "bedrock_profile_arn" {
  type = string
}

variable "recovery_signing_secret_arn" {
  type = string
}
variable "renewal_public_key" { type = string }
variable "worker_scopes" {
  type    = string
  default = "[]"
}

variable "alert_email" {
  type = string
}

variable "monthly_budget_usd" {
  type    = number
  default = 500
}
