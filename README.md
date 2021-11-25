# unifi-webex-dl

> Download recorded lessons from UniFi's Webex platform passing by the Moodle platform.

This utility can automatically download all UniFi courses' recordings saved on webex.

## Quick Start

The easiest way to start is by downloading the pre-compiled application from the latest release available.

Then, copy the `config.example.json` file to a new file named `config.json` and change the credentials and courses ids accordingly.

Done, that's it!

While being the easiest method, it does come with a drawback. To update it, you'll have to manually check the repository once in a while and download the latest version. For this reason, if possible, it is recommended to use the following method that uses Node directly.

## [Optional] Quick Start with Node

Node.js v14 or newer is required.

- Install project dependencies: `npm ci`

- Copy `config.example.json` to a new file named `config.json` and change credentials and courses ids accordingly.

- Run the app with: `npm start`

When you pull new updates, remember to update project dependencies using `npm ci`.

## [Optional] Quick Start with Docker

Suppose you are on Linux and have docker. In that case, you can execute the `docker.sh` to automatically execute the downloader inside of a container.

Note a few things:

- Make sure to use the same UID and GID of your user in the `Dockerfile`. By default, they are both set to 1000;
- If you use `.yaml` configs instead of `.json`, change the extension accordingly in `docker.sh`

## PLEASE NOTE - Known issues

Errors related to stream downloads:

- If a recording doesn't seem to have the audio while reproducing it with the Windows Media Player, try with a different player such as VLC.
- If there are stutters while scrubbing the timeline, this is caused by the way HLS recordings are downloaded. To solve this, install `ffmpeg`, enable the `fix_streams_with_ffmpeg` option and then delete-and-redownload the stream recordings.

If a recording gives you an error, verify on Webex that it can actually be opened before opening an issue. Recordings could be disabled by the course organizer.

If you get a `429 Error`, it means that Webex received too many requests. In this case, you should wait sometime before trying again.

If you download an event recording that doesn't ask for a password, it probably won't work. This case never occurred in my testings. Feel free to open an issue to let me know what happens.

## Config

> The config file has 3 sections.

Currently, both **.json** and **.yaml** file are supported, json being the default one.

The default config file path is `config.json` inside the root directory; you can change it with the environment variable `CONFIG_PATH`.

### Credentials

| Key name   | Value type | Optional | Default value | Description                                              |
|------------|------------|----------|---------------|----------------------------------------------------------|
| `username` | string     | No       |               | Username used for authenticating to the Moodle Platform. |
| `password` | string     | No       |               | Password used for authenticating to the Moodle Platform. |

### Download

| Key name                   | Value type | Optional | Default value | Description                                                                                                                                                                                   |
|----------------------------|------------|----------|---------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `base_path`                | string     | No       |               | Path in which to download recordings.                                                                                                                                                         |
| `progress_bar`             | boolean    | Yes      | true          | Show a progress bar while downloading the recordings.                                                                                                                                         |
| `show_existing`            | boolean    | Yes      | true          | Show already downloaded recordings.                                                                                                                                                           |
| `max_concurrent_downloads` | number     | Yes      | 3             | maximum number of parallel downloads.                                                                                                                                                         |
| `fix_streams_with_ffmpeg`  | boolean    | Yes      | false         | Remux HLS recordings using ffmpeg. This requires ffmpeg to be installed and available on system path. Additionally, check that the h264/MPEG-4 formats are supported for remuxing operations. |

### Courses

> Array of objects, one for each course. The object contains the following fields.

Please note that on Windows the `name` field shouldn't contain any of the not allowed characters, such as `: " *`. It is therefore recommended to keep the name simple using only letters, numbers, hyphens, and underscores.

| Key name           | Value type | Optional | Description                                                                                                         |
|--------------------|------------|----------|---------------------------------------------------------------------------------------------------------------------|
| `id`               | string     | No       | Id of the course shown in the URL bar of the Moodle's course page.                                                  |
| `name`             | string     | No       | Name prepended to the folder name and also shown in the logs.                                                       |
| `custom_webex_id`  | string     | Yes      | Manually set the id of the Webex page instead of trying to find it in the course page.                              |
| `skip_names`       | string     | Yes      | Regex to match recordings names to skip. Exclude slashes and flags from strings. E.g. `'test'` and NOT `'/test/i'`. |
| `skip_before_date` | string     | Yes      | Skip recordings before the date `YYYY-MM-DD`.                                                                       |
| `skip_after_date`  | string     | Yes      | Skip recordings after the date `YYYY-MM-DD`.                                                                        |
| `prepend_date`     | boolean    | Yes      | Prepend the date of the recording (`YYYYMMDD-`) to the filenames.                                                   |

## Environment variables

The app tries to be as docker-friendly as possible.

In fact, as an alternative, the configs may all be specified using environment variables. Just convert the config names to uppercase. In the case of nested properties, separate them with two underscores.

E.g. `credentials.username` => `CREDENTIALS__USERNAME`; `download.base_path` => `DOWNLOAD__BASE_PATH`

Courses can also be specified through the `COURSES` env variable using the following format, although limited to only `id` and `name`:

`COURSE_ID=COURSE_NAME,12003=WhiteRabbit`

## Logging

To modify the default log level of 'info', set the env variable `LOG_LEVEL` with one of [winston available log_level](https://github.com/winstonjs/winston#logging-levels).

## How it works

Unfortunately, UniFi Moodle doesn't make use of REST APIs. So we have to do a bit of guessing and matching on the response body.

This approach works for now but is prone to errors and will stop working if things change. Feel free to open an issue or a PR to report these changes.

### Login to Moodle

_As of March 2021, they use this new unified authentication system for accessing their services._

> GET <https://identity.unifi.it/cas/login?service=https://e-l.unifi.it/login/index.php?authCASattras=CASattras>

In the response body match

`<input type="hidden" name="execution" value="..."/>`.

Then post the form with the `execution` field.

> POST <https://identity.unifi.it/cas/login?service=https://e-l.unifi.it/login/index.php?authCASattras=CASattras>
>
> Content-Type: application/x-www-form-urlencoded

The request body should match the following format:

```json
{
    "username": 00000,
    "password": "*****",
    "execution": "...",
    "_eventId": "submit",
    "geolocation": ""
}
```

If the credentials are wrong, a status code `401` should be returned from the POST request.

Otherwise, follow the `Location` header that should have a ticket in the URL parameters.

Set `MoodleSession` Cookie from the Set-Cookie response header and follow the `Location` header again.

Finally, get the authenticated `MoodleSession` Cookie from the Set-Cookie response header.

### Get Webex Id

To launch Webex, we have to get the Webex course id relative to the moodle course id.

> GET <https://e-l.unifi.it/course/view.php?id=42>

In the body, match the launch URL:

- `https://e-l.unifi.it/mod/lti/launch.php?id=***`

Retrieve the id parameter

### Get Webex launch parameters

> GET <https://e-l.unifi.it/mod/lti/launch.php?id=1337>>
>
> Cookie: MoodleSession

Serialize from the HTML body all the name attributes in input tags

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

Before starting, it's essential to understand that there are two types of recordings.

There are recordings of `Meetings` and recordings of `Events`.

This two share only the last part of the process.

The program first tries to download the files using the download function available in Webex.
But, if it has been disabled, it tries to download the HLS stream using the streaming functionality of Webex.

Start off with [Step 1a](#download-a-recording---step-1a)

### Download a recording - STEP 1a

> GET `file_url`

1. If the response matches `Error` then, there's been an error. Probably the recording has been deleted or isn't available at the moment.
Try with `recording_url` at [Step 1b](#download-a-hls-stream---step-1)

2. If the response contains `'internalRecordTicket'` then you're downloading an event. Goto [STEP 2b](#download-a-recording---step-2b)

3. If none of the above, then you're downloading a meeting. Goto [STEP 2a](#download-a-recording---step-2a)

### Download a recording - STEP 2a

If the response of the previous step doesn't contain `recordingpasswordcheck`, the recording doesn't need a password, and you can skip to [STEP 3](#download-a-recording---step-3). Also, note that if the response doesn't contain "commonGet2PostForm", you should instead skip to STEP 3 after the first request to `nbrshared.do`.

Otherwise, follow along...

Get all `name` and `values` attributes from the input tags.

Note that you may need to change `firstEntry` to false since the js does it there:

```js
document.forms[0].firstEntry.value=false;
```

> POST <https://unifirenze.webex.com/svc3300/svccomponents/servicerecordings/recordingpasswordcheck.do>

The body should contain the input attributes from the previous request and the password of the recording.

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

Save cookies from the response header.

Parse from the response the following fields:

- formId
- accessType
- internalPBRecordTicket
- internalDWRecordTicket

> POST `https://unifirenze.webex.com/ec3300/eventcenter/enroll/viewrecord.do`
>
> Content-Type: application/x-www-form-urlencoded
>
> Cookie: From the previous step

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

From the previous request match `var href='https://unifirenze.webex.com/mw3300/mywebex/nbrshared.do?siteurl=unifirenze-en&action=publishfile&recordID=***&serviceRecordID=***&recordKey=***';`

Parse the URL arguments and make the following request.

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

This is the function declaration `func_prepare(status, url, ticket)` that I'll refer to.

Check the `status` that could be one of the following [`OKOK`, `Preparing`, `Error`, "null if bug?"]

- Error:
  - Throw error and skip this file
- Preparing:
  - Fetch again GET "https://unifirenze.webex.com/mw3300/mywebex/nbrPrepare.do?siteurl=unifirenze-en" + `url`
- OKOK:
  - Match `var downloadUrl = 'https://***.webex.com/nbr/MultiThreadDownloadServlet?siteid=***&recordid=***&confid=***&language=1&userid=***&serviceRecordID=***&ticket=' + ticket;`

> GET `MultiThreadDownloadServlet`

The response is the recording that can be saved as `name`.`format` (from the recording object).

### Download a HLS Stream - STEP 1

> GET `recording_url`

1. If the response matches `Error` then, there's been an error. This recording will be `Skipped`

2. If the response contains `'internalRecordTicket'`, then you're downloading an event. This is a `WIP` since I never found an event recording with download disabled. Feel free to open an Issue to solve this.

3. If none of the above, then you're downloading a meeting. Goto [Download a HLS Stream](#download-a-hls-stream---step-2)

### Download a HLS Stream - STEP 2

From the response of the `recording_url`, match the recording ID.

```js
location.href='https://unifirenze.webex.com/recordingservice/sites/unifirenze/recording/playback/RECORDING_ID';
```

> GET <https://unifirenze.webex.com/webappng/api/v1/recordings/RECORDING_ID/stream?siteurl=unifirenze>

In the request, also add the following custom header

`accessPwd: RECORDING_PASSWORD`

In the response JSON object, save the parameter: `mp4StreamOption`

**Optionally**: if you wanna get the approximate filesize, sum `fileSize` with `mediaDetectInfo.audioSize`

### Download a HLS Stream - STEP 3

> POST <https://nfg1vss.webex.com/apis/html5-pipeline.do>

In the request, add the following query parameters from the `mp4StreamOption` object of the previous step:

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

Use all parameters in this URL, and you get the HLS Playlist file to download

```js
let playlistFile = `https://nfg1vss.webex.com/hls-vod/recordingDir/${mp4StreamOption.recordingDir}/timestamp/${mp4StreamOption.timestamp}/token/${mp4StreamOption.token}/fileName/${HLS_FILE}.m3u8`
```
