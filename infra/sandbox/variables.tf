variable "name" {
  type    = string
  default = "regi-personal"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,23}$", var.name))
    error_message = "Use a short lowercase sandbox name."
  }
}
variable "expected_account_id" {
  type = string
  validation {
    condition     = can(regex("^[0-9]{12}$", var.expected_account_id))
    error_message = "Explicitly confirm the 12-digit AWS account."
  }
}
variable "alert_email" {
  type = string
  validation {
    condition     = can(regex("^[^@ ]+@[^@ ]+\\.[^@ ]+$", var.alert_email))
    error_message = "A real notification email is required."
  }
}
variable "monthly_budget_usd" {
  type    = number
  default = 30
  validation {
    condition     = var.monthly_budget_usd > 0 && var.monthly_budget_usd <= 100
    error_message = "Sandbox alert must be explicitly within USD 1–100; this is not a spending cap."
  }
}
variable "require_mfa" {
  type    = bool
  default = true
  validation {
    condition     = var.require_mfa || var.demo.enabled
    error_message = "Password-only login is allowed only for an explicitly enabled synthetic personal sandbox."
  }
}
variable "image_object_key" {
  type    = string
  default = "releases/regi-app.tar.gz"
  validation {
    condition     = can(regex("^releases/[a-zA-Z0-9._/-]+\\.tar\\.gz$", var.image_object_key)) && !strcontains(var.image_object_key, "..")
    error_message = "Use an image archive under releases/, never state/."
  }
}
variable "bootstrap_bucket" {
  type = string
  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9.-]{2,62}$", var.bootstrap_bucket))
    error_message = "Supply the separately managed private bootstrap bucket."
  }
}
variable "image_sha256" {
  type    = string
  default = ""
  validation {
    condition     = var.image_sha256 == "" || can(regex("^[0-9a-f]{64}$", var.image_sha256))
    error_message = "Supply the SHA-256 of the uploaded archive. Empty keeps the host waiting; it does not run an unverified image."
  }
}
variable "demo" {
  type    = object({ enabled = bool, tenant_id = string, administrator_subject = string, end_day = string })
  default = { enabled = false, tenant_id = "", administrator_subject = "", end_day = "" }
  validation {
    condition     = !var.demo.enabled || (can(regex("^[0-9a-f-]{36}$", var.demo.tenant_id)) && can(regex("^[0-9a-f-]{36}$", var.demo.administrator_subject)) && can(regex("^[0-9]{4}-[0-9]{2}-[0-9]{2}$", var.demo.end_day)))
    error_message = "Demo execution requires an explicitly confirmed tenant UUID, actual Cognito sub and history end day."
  }
}
variable "bedrock_profile_arn" {
  type    = string
  default = ""
  validation {
    condition     = var.bedrock_profile_arn == "" || can(regex("^arn:aws:bedrock:ap-northeast-1:[0-9]{12}:(application-)?inference-profile/", var.bedrock_profile_arn))
    error_message = "AI is off by default. Only an independently approved Tokyo inference profile can enable it."
  }
}
