/**
 * 参数校验工具模块
 * 提供常用的输入校验函数，防止非法参数进入业务逻辑。
 */
const { fail } = require('./response');

/**
 * 非空字符串校验
 */
function requiredString(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return fail(`${name}不能为空`);
  }
  return null;
}

/**
 * 正整数校验
 */
function positiveInt(value, name) {
  const num = Number(value);
  if (!Number.isInteger(num) || num <= 0) {
    return fail(`${name}必须为正整数`);
  }
  return null;
}

/**
 * 枚举值校验
 */
function inEnum(value, enums, name) {
  if (!enums.includes(value)) {
    return fail(`${name}取值非法`);
  }
  return null;
}

/**
 * 数组校验
 */
function isArray(value, name) {
  if (!Array.isArray(value)) {
    return fail(`${name}必须为数组`);
  }
  return null;
}

module.exports = { requiredString, positiveInt, inEnum, isArray };
