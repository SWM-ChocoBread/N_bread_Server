import { Response } from 'express';

const success = (
  res: Response,
  code: number,
  message: string,
  result?: any,
) => {
  const success_result = { code, success: true, message, result };
  return res.status(code).send(success_result);
};

const fail = (res: Response, code: number, message: string) => {
  const fail_result = { code, success: false, message };
  return res.status(code).send(fail_result);
};

export { success, fail };
