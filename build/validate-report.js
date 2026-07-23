#!/usr/bin/env node
/**
 * validate-report.js
 *
 * Validates a report.json against the daily_report.schema.json schema.
 *
 * Usage:
 *   node build/validate-report.js <report.json> <schema.json>
 */

const fs = require('fs');
const path = require('path');

function main() {
  const reportPath = process.argv[2];
  const schemaPath = process.argv[3];

  if (!reportPath || !schemaPath) {
    console.error('Usage: node validate-report.js <report.json> <schema.json>');
    process.exit(1);
  }

  if (!fs.existsSync(reportPath)) {
    console.error(`Report file not found: ${reportPath}`);
    process.exit(1);
  }

  if (!fs.existsSync(schemaPath)) {
    console.error(`Schema file not found: ${schemaPath}`);
    process.exit(1);
  }

  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

  // Try to use ajv for validation
  let valid = true;
  let errors = [];

  try {
    const { Ajv2020 } = require('ajv/dist/2020');
    const addFormats = require('ajv-formats');
    const ajv = new Ajv2020({ allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile(schema);
    valid = validate(report);
    if (!valid) {
      errors = validate.errors || [];
    }
  } catch (e) {
    // ajv not installed or failed, do basic validation
    console.warn('ajv validation unavailable, doing basic validation...');
    valid = basicValidate(report, schema);
  }

  if (valid) {
    console.log('✅ Report is valid against the schema.');
    console.log(`   Report: ${reportPath}`);
    console.log(`   Schema: ${schemaPath}`);
    console.log(`   Generated at: ${report.generated_at || 'unknown'}`);
    console.log(`   New models: ${report.new_models?.length || 0}`);
    console.log(`   Changes: ${report.changes?.length || 0}`);
    console.log(`   Ranked offers: ${report.ranked_offers?.length || 0}`);
    console.log(`   Excluded: ${report.excluded_offers?.length || 0}`);
    const fieldReport = reportNewFields(report);
    console.log(`   Ranking eligible with last_verified: ${fieldReport.verified}/${fieldReport.eligible}`);
    console.log(`   Router offers with free_model_names: ${fieldReport.routersWithModels}/${fieldReport.routers}`);
    process.exit(0);
  } else {
    console.error('❌ Report validation failed!');
    console.error(`   Report: ${reportPath}`);
    console.error(`   Schema: ${schemaPath}`);
    if (errors.length > 0) {
      console.error('   Errors:');
      errors.forEach(err => {
        console.error(`     - ${err.instancePath || 'root'}: ${err.message}`);
      });
    }
    process.exit(1);
  }
}

// Summarise the two fields added by spec 0002 (last_verified, free_model_names).
function reportNewFields(report) {
  const offers = report.ranked_offers || [];
  const eligible = offers.filter(o => o.ranking_eligible === true);
  const verified = eligible.filter(o => typeof o.last_verified === 'string' && o.last_verified.length > 0);
  const routers = offers.filter(o => o.delivery_type === 'router');
  const routersWithModels = routers.filter(o => Array.isArray(o.free_model_names) && o.free_model_names.length > 0);
  return { eligible: eligible.length, verified: verified.length, routers: routers.length, routersWithModels: routersWithModels.length };
}

function basicValidate(report, schema) {
  // Check required fields
  for (const req of schema.required || []) {
    if (!(req in report)) {
      console.error(`Missing required field: ${req}`);
      return false;
    }
  }
  // Spec 0002 invariants (mirrors the schema allOf, for the no-ajv fallback path).
  for (const o of report.ranked_offers || []) {
    if (o.ranking_eligible === true && !(typeof o.last_verified === 'string' && o.last_verified.length > 0)) {
      console.error(`Ranking eligible offer missing last_verified: ${o.name}`);
      return false;
    }
    if (o.delivery_type === 'router' && !(Array.isArray(o.free_model_names) && o.free_model_names.length > 0)) {
      console.error(`Router offer missing non-empty free_model_names: ${o.name}`);
      return false;
    }
  }
  // Check types
  if (typeof report.generated_at !== 'string') {
    console.error('generated_at must be a string');
    return false;
  }
  if (typeof report.timezone !== 'string') {
    console.error('timezone must be a string');
    return false;
  }
  if (!Array.isArray(report.new_models)) {
    console.error('new_models must be an array');
    return false;
  }
  if (!Array.isArray(report.changes)) {
    console.error('changes must be an array');
    return false;
  }
  if (!Array.isArray(report.ranked_offers)) {
    console.error('ranked_offers must be an array');
    return false;
  }
  if (!Array.isArray(report.excluded_offers)) {
    console.error('excluded_offers must be an array');
    return false;
  }
  if (!Array.isArray(report.sources)) {
    console.error('sources must be an array');
    return false;
  }
  return true;
}


main();
