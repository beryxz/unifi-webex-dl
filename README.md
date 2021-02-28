# UNIFI-WEBEX-DL

> Download recorded lessons from unifi webex platform passing by the Moodle platform.

## Requirements

- Node.js v14 or newer

## Quick Start

Install project dependencies: `npm install`

Copy `config.example.json` to `config.json` and change credentials and courses ids accordingly.

Run the app with: `npm start`

## Config

> The config file has 3 sections.

Currently, both **.json** and **.yaml** file are supported, json being the default one.

Default config file path is `config.json` inside of the root directory, you can change it with the environment variable `CONFIG_PATH`.

### Credentials

- `username`: used for authenticating to the Moodle Platform.
- `password`: used for authenticating to the Moodle Platform.

### Download

- `base_path`: path in which to download recordings
- `progress_bar`: (Optional) boolean to set whether or not to show a progress bar while downloading the recordings. Defaults to `true`
- `show_existing`: (Optional) boolean to set whether or not to show already downloaded recordings. Defaults to `true`

### Courses

> Array of objects, one for each course. The object contains:

- `id` string: id of the course shown in the url bar of Moodle
- `name` string: prepended to the folder name and also shown in the logs
- `skip_names` string: (Optional) regex to match recordings names to skip. Exclude slashes and flags from strings. E.g. `'test'` and NOT `'/test/i'`
- `skip_before_date` string: (Optional) skip recordings before the date `YYYY-MM-DD`
- `skip_after_date` string: (Optional) skip recordings after the date `YYYY-MM-DD`
- `prepend_date` boolean: (Optional) prepend the date of the recording (`YYYYMMDD-`) to the filename

## Environment variables

The app tries to be as docker friendly as possible.

In alternative the configs may be specified using environment variables. Just convert the config names to uppercase. In case of nested properties, separe them with two underscores.

E.g. `credentials.username` => `CREDENTIALS__USERNAME`; `download.base_path` => `DOWNLOAD__BASE_PATH`

Courses can also be specified throught the `COURSES` env variable using the following format although limited to only `id` and `name`:

`COURSE_ID=COURSE_NAME,12003=WhiteRabbit`

## Logging

To modify the default log level of 'info', set the env variable `LOG_LEVEL` with one of [winston available log_level](https://github.com/winstonjs/winston#logging-levels).

## Known issues

If you download an event recording that doesn't ask for password, it probably won't work. This case never occurred in my testing. Feel free to open an issue to let me know what happens.

## How it works

Unfortunately, UniFi Moodle doesn't make use of rest apis. So we have to do a bit of guessing and matching on the response body.

This approch works for now but is prone to errors and stop working if something get changed. Feel free to open an issue or a PR to update the process.

### Login to Moodle

> GET <https://e-l.unifi.it/login/index.php>

Get `MoodleSession` cookie from header and in the response body match the first

`<input type="hidden" name="logintoken" value="P1pp0Plu70">`.

Then post the form with the loginToken.

> POST <https://e-l.unifi.it/login/index.php>
>
> Content-Type: application/x-www-form-urlencoded
>
> Cookie: MoodleSession

The request body should match the following

```json
{
    "anchor": null,
    "logintoken": "P1pp0Plu70",
    "username": 00000,
    "password": "*****",
    "rememberusername": 0
}
```

Update `MoodleSession` Cookie from Set-Cookie response header.

Verify that everything is fine.

> GET <https://e-l.unifi.it/login/index.php>
>
> Cookie: MoodleSession

If the body doesn't contain `loginerrormessage`, you should be logged in.

### Get Webex Id

To launch webex we have to get the webex id relative to the moodle course id.

> GET <https://e-l.unifi.it/course/view.php?id=42>

In the body match the launch url. Either of these:

- `https://e-l.unifi.it/mod/lti/launch.php?id=***`
- `https://e-l.unifi.it/mod/lti/view.php?id=***`

Retrieve the id parameter

### Get Webex launch parameters

> GET <https://e-l.unifi.it/mod/lti/launch.php?id=1337>
>
> Cookie: MoodleSession

Serialize from the html body all the name attributes in input tags

### Launch Webex

> POST <https://lti.educonnector.io/launches>
>
> Content-Type: application/x-www-form-urlencoded

In the body send the parameters retrieved [from Moodle](#get-webex-launch-parameters)

From the response:

Get cookies [`ahoy_visitor`, `ahoy_visit`, `_ea_involvio_lti_session`]

### Get Webex course recordings

> GET <https://lti.educonnector.io/api/webex/recordings>

The request headers should match the following

```html
Cookie: ahoy_visitor=***,ahoy_visit=***,_ea_involvio_lti_session=***
```

The response is an array of objects like the following

```json
[
    {
        "created_at": "2020-01-13T00:00:00.000-07:00",
        "duration_hour": 0,
        "duration_min": 0,
        "duration_sec": 0,
        "file_url": "https://unifirenze.webex.com/unifirenze/lsr.php?RCID=******",
        "format": "MP4",
        "id": 0,
        "name": "",
        "password": "",
        "recording_url": "https://unifirenze.webex.com/unifirenze/ldr.php?RCID=******",
        "timezone": "Europe/Rome",
        "updated_at": "2020-01-13T00:00:00.000-07:00"
    }
]
```

### Download a recording - STEP 1

Before starting, it's important to understand that there are two types of recordings.

There are recordings of `Meetings` and recordings of `Events`.

These two share only the last part of the process.

The program first tries to download the files using the download function available in webex.
But, since it can be disabled, in case it has been disabled, it tries to download the HLS stream using the streaming function of webex.

Start off with [Step 1a](#download-a-recording---step-1a)

### Download a recording - STEP 1a

> GET `file_url`

1. If the response matches `Error` then, there's been an error. Probably the recording has been deleted or isn't available at the moment.
Try with `recording_url` at [Step 1b](#download-a-recording---step-1b)

2. If the response contains `'internalRecordTicket'` then you're downloading an event. Goto [STEP 2b](#download-a-recording---step-2b)

3. If none of the above then you're downloading a meeting. Goto [STEP 2a](#download-a-recording---step-2a)

### Download a recording - STEP 1b

> GET `recording_url`

1. If the response matches `Error` then, there's been an error. This recording will be `Skipped`

2. If the response contains `'internalRecordTicket'` then you're downloading an event. This is a `WIP` since i never found an event recording with download disabled. Fell free to open an Issue to solve this.

3. If none of the above then you're downloading a meeting. Goto [Download a HLS Stream](#download-a-hls-stream---step-2)

### Download a recording - STEP 2a

If the response of the previous step doesn't contains `recordingpasswordcheck`, the recording doesn't need a password and you can skip to [STEP 3](#download-a-recording---step-3) as if you alredy made the post request.

Otherwise follow along...

Get all `name` and `values` attributes from the input tags.

Note that you may need to change `firstEntry` to false since the js does it here:

```js
document.forms[0].firstEntry.value=false;
```

> POST <https://unifirenze.webex.com/svc3300/svccomponents/servicerecordings/recordingpasswordcheck.do>

The body should contain the input attributes from the previous request and the password of the recording

Then match `var href='https://unifirenze.webex.com/mw3300/mywebex/nbrshared.do?siteurl=unifirenze-en&action=publishfile&recordID=***&serviceRecordID=***&recordKey=***';`

Goto [STEP 3](#download-a-recording---step-3)

### Download a recording - STEP 2b

> Follow the `redirect` of the previous request.

Serialize the form inputs and:

- add password to `playbackPasswd=`
- change `theAction=...` to `theAction=check_pass`
- change `accessType=...` to `accessType=downloadRecording`

> POST `https://unifirenze.webex.com/ec3300/eventcenter/recording/recordAction.do`
>
> Content-Type: application/x-www-form-urlencoded

Save cookies from response header.

Parse from the response the following fields:

- formId
- accessType
- internalPBRecordTicket
- internalDWRecordTicket

> POST `https://unifirenze.webex.com/ec3300/eventcenter/enroll/viewrecord.do`
>
> Content-Type: application/x-www-form-urlencoded
>
> Cookie: From previous step

Request body:

```jsonc
{
  "firstName": "Anonymous",
  "lastName": "Anonymous",
  "siteurl": "unifirenze",
  "directview": 1,
  "AT": "ViewAction",
  "recordId": 0000, // formId of the previous step
  "accessType": "downloadRecording",
  "internalPBRecordTicket": "4832534b000000040...",
  "internalDWRecordTicket": "4832534b00000004f..."
}
```

Parse from the response the following fields:

- siteurl
- recordKey
- recordID
- serviceRecordID

[STEP 3](#download-a-recording---step-3)

### Download a recording - STEP 3

> POST `https://unifirenze.webex.com/mw3300/mywebex/nbrshared.do`
>
> Content-Type: application/x-www-form-urlencoded

Request body:

```jsonc
{
  "action": "publishfile", // always required
  "siteurl": "unifirenze", // could also be 'unifirenze-en'
  "recordKey": "***",
  "recordID": "***",
  "serviceRecordID": "***",
}
```

Match the following part

```js
    function download(){
        document.title="Download file";
        var recordId = 000;
        var serviceRecordId = 000;
        var prepareTicket = '******';
        var comeFrom = '';
        var url = "https://unifirenze.webex.com/mw3300/mywebex/nbrPrepare.do?siteurl=unifirenze-en" + "&recordid=" + recordId+"&prepareTicket=" + prepareTicket;
        if (serviceRecordId > 0) {
            url = url + "&serviceRecordId=" + serviceRecordId;
        }

        _refreshIFrame(url,1);
    }
```

> GET `matched nbrPrepare.do url`

Match `window.parent.func_prepare('***','***','***');`

This is the function declaration `func_prepare(status, url, ticket)` that i'll reefer to.

Check the `status` that could be one of the following [`OKOK`, `Preparing`, `Error`, "null if bug?"]

- Error:
  - Throw error and skip this file
- Preparing:
  - Fetch again GET "https://unifirenze.webex.com/mw3300/mywebex/nbrPrepare.do?siteurl=unifirenze-en" + `url`
- OKOK:
  - Match `var downloadUrl = 'https://***.webex.com/nbr/MultiThreadDownloadServlet?siteid=***&recordid=***&confid=***&language=1&userid=***&serviceRecordID=***&ticket=' + ticket;`

> GET `MultiThreadDownloadServlet`

The response is the recording that can be saved as `name`.`format` (from the recording object).

### Download a HLS Stream - STEP 2

From the response of the `recording_url`, match the recording ID.

```js
location.href='https://unifirenze.webex.com/recordingservice/sites/unifirenze/recording/playback/RECORDING_ID';
```

> GET <https://unifirenze.webex.com/webappng/api/v1/recordings/RECORDING_ID/stream?siteurl=unifirenze>

In the request also add the following custom header

`accessPwd: RECORDING_PASSWORD`

In the response json object save the parameter: `mp4StreamOption`

**Optionally**: if you wanna get the approximate filesize, sum `fileSize` with `mediaDetectInfo.audioSize`

### Download a HLS Stream - STEP 3

> POST <https://nln1vss.webex.com/apis/html5-pipeline.do>

In the request add the following query parameters from the `mp4StreamOption` object of the previous step:

```json
{
  "recordingDir": "",
  "timestamp": 0,
  "token": "",
  "xmlName": ""
}
```

From the response match `HLS_FILE`

```xml
<Screen ...>
  <Sequence ...>HLS_FILE</Sequence>
</Screen>
```

Use all parameters in this url and you got the HLS Playlist file to download

```js
let playlistFile = `https://nln1vss.webex.com/hls-vod/recordingDir/${mp4StreamOption.recordingDir}/timestamp/${mp4StreamOption.timestamp}/token/${mp4StreamOption.token}/fileName/${HLS_FILE}.m3u8`
```
