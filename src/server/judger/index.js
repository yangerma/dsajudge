import path from 'path';
import config from '/config';
import Submission from '/schema/submission';
import sleep from 'sleep-promise';
import {CppExec, compile, judge} from './shik';
import {mergeResult} from './utils';
import _ from 'lodash';
import logger from '/logger';
import {Error} from 'common-errors';
import fs from 'fs-promise';

const DEFAULT_CHECKER = path.join(config.dirs.cfiles, 'default_checker.cpp');
const TESTLIB = path.join(config.dirs.cfiles, 'testlib.h');

async function runAndCheck(userExec, checkExec, inFile, ansFile, timeLimit, memLimit) {
    let res = await userExec.run(inFile, timeLimit, memLimit);
    const ret = {runtime: res.stat.cpu_time_usage};
    if (res.stat.TLE) return _.assignIn({result: 'TLE'}, ret);
    if (res.stat.RE) return _.assignIn({result: 'RE'}, ret);

    const neededFiles = [inFile, res.outFile, ansFile];
    checkExec.prepareFiles(neededFiles);
    let checkRes = await checkExec.run(
        undefined, 30, 1<<30, neededFiles.map(x => path.basename(x)));

    if (res.stat.TLE) throw Error('Checker time limit exceeded');
    if (res.stat.RE) return _.assignIn({result: 'WA'}, ret);

    return _.assignIn({result: 'AC'}, ret);
}

const resultMap = {
    'CE': 100000,
    'RE': 10000,
    'WA': 1000,
    'TLE': 100,
    'AC': 1,
};
function resultReducer(res, x) {
    const resW = _.get(resultMap, res.result, 1e9),
          xW = _.get(resultMap, x.result, 1e9);
    const res_ = {};
    res_.result = resW > xW ? res.result : x.result;
    res_.runtime = Math.max(res.runtime, x.cpu_time_usage);
    return res_;
}

async function _startJudge(sub) {

    const cppFile = path.join(config.dirs.submissions, `${sub._id}.cpp`);
    const userExec = new CppExec(cppFile);
    await userExec.init();
    const compileResult = await userExec.compile();

    if (compileResult.stat.RE) {
        sub.results.result = 'CE';
        sub.results.points = 0;
        await sub.save();
        await fs.copy(compileResult.stderr,
            path.join(config.dirs.submissions, `${sub._id}.compile.err`));
        userExec.clean();
        return sub;
    }


    let checker;
    if (sub.problem.meta.hasSpecialJudge) {
        checker = path.join(config.dirs.problems, `${sub.problem._id}`, 'checker.cpp');
    } else {
        checker = DEFAULT_CHECKER;
    }
    const checkerExec = new CppExec(checker);
    await checkerExec.init();
    await checkerExec.prepareFiles([TESTLIB]);
    await checkerExec.compile();
    if (checkerExec.status !== 'compiled') {
        throw Error('Checker compiled failed');
    }

    const tds = [];
    const remains = [];
    sub.problem.testdata.groups.forEach(
        (x, i) => {
            remains.push(x.count);
            sub.results.groups[i] = {
                points: 0,
                tests: ((l) => {
                    let ls = []; 
                    for (let i=0; i<l; i++) ls.push(undefined);
                    return ls;
                    //ls.length = l; return ls;
                })(x.count),
            };
            x.tests.forEach((y, j) => tds.push({
                gid: i,
                tid: j,
                testName: y,
            }));
        }
    );

    sub.markModified('results.groups');
    await sub.save();

    const probDir = path.join(config.dirs.problems, `${sub.problem._id}`, 'testdatas');
    const {timeLimit} = sub.problem.meta;

    for (let td of tds) {
        const {gid, tid, testName} = td;
        const [inFile, ansFile] = ['in', 'out'].map(ext => path.join(probDir, `${testName}.${ext}`));
        const judgeResult = (await runAndCheck(
            userExec, checkerExec, inFile, ansFile, timeLimit
        ));
        const gRes = sub.results.groups[gid];
        gRes.tests.set(tid, judgeResult);

        remains[gid] --;
        if (!remains[gid]) {
            console.log(sub.results.groups[gid].tests);
            const res = _.reduce(
                gRes.tests, resultReducer, {result: 'AC', runtime: 0});
            gRes.result = res.result;
            gRes.points = res.runtime;
            gRes.points = (res.result === 'AC' ? sub.problem.testdata.groups[gid].points : 0);
        }
        sub.markModified('results.groups');
        await sub.save();
    }

    console.log(sub.results.groups);
    sub.results.points = _.reduce(sub.results.groups, (v, x) => v + x.points, 0);
    sub.results.result = mergeResult(_.map(sub.results.groups, (x) => x.result));
    await sub.save();
}

async function startJudge(sub) {
    sub.status = 'judging';
    await sub.save();
    try {
        logger.info(`judging #${sub._id}`);
        await _startJudge(sub);
    } catch(e) {
        sub.status = 'error';
        logger.error(`#${sub._id} judge error`, e);
        await sub.save();
        return;
    }
    sub.status = 'finished';
    logger.info(`judge #${sub._id} finished, result = ${sub.results.result}`);
    await sub.save();
}

async function mainLoop() {
    while (true) {
        const pending = await (
            Submission.findOne({status: 'pending'})
                .populate('problem')
                .populate('submittedBy')
        );
        if (!pending) {
            await sleep(1000);
            continue;
        }

        await startJudge(pending);
        await sleep(50);
    }
}

export default mainLoop;