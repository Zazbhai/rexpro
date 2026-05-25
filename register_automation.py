import os
import sys
import json
import re
import time
import urllib.request
import urllib.parse
from typing import Any, Dict, Optional, Tuple
from playwright.sync_api import sync_playwright

# -------------------------------------------------------------
# Configuration Loader
# -------------------------------------------------------------
def load_config() -> Dict[str, Any]:
    config_path = os.path.join(os.path.dirname(__file__), "config.json")
    if os.path.exists(config_path):
        try:
            with open(config_path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            print(f"Error loading config.json: {e}")
    # Default fallbacks
    return {
        "SMS_BASE_URL": "https://zotp.in/stubs/handler_api.php",
        "API_KEY": "2ce12168a4f72374207d61fc634ba23c79cf",
        "OPERATOR": "10",
        "COUNTRY": "22",
        "SERVICE": "lmeh",
        "TARGET_BASE_URL": "https://rcapi.rexproearn.com/app/user",
        "PASSWORD": "Zazbhai8709#",
        "INVITE_CODE": "TDPARP"
    }

# -------------------------------------------------------------
# SMS Service API Helpers
# -------------------------------------------------------------
def _http_get(params: Dict[str, Any], config: Dict[str, Any]) -> str:
    merged = {"api_key": config["API_KEY"], **params}
    url = f"{config['SMS_BASE_URL']}?{urllib.parse.urlencode(merged)}"
    
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.read().decode("utf-8").strip()
    except Exception as exc:
        raise ValueError(f"SMS API HTTP GET Error: {exc}")

def get_number(config: Dict[str, Any]) -> Optional[Tuple[str, str]]:
    raw = _http_get({
        "action": "getNumber",
        "service": config["SERVICE"],
        "country": config["COUNTRY"],
        "operator": config["OPERATOR"]
    }, config)
    return parse_number(raw)

def parse_number(text: str) -> Optional[Tuple[str, str]]:
    if not text.startswith("ACCESS_NUMBER:"):
        return None
    try:
        parts = text.split(":")
        req_id = parts[1]
        number = parts[2]
        if number.startswith("91") and len(number) > 2:
            number = number[2:]
        return req_id, number
    except Exception:
        return None

def cancel_number(request_id: str, config: Dict[str, Any]) -> str:
    return _http_get({"action": "setStatus", "status": 8, "id": request_id}, config)

def get_otp(
    request_id: str,
    timeout_seconds: float = 30.0,
    poll_interval: float = 2.0,
    config: Dict[str, Any] = None
) -> Optional[str]:
    deadline = time.time() + timeout_seconds
    while True:
        try:
            response = _http_get({"action": "getStatus", "id": request_id}, config)
            status, otp = parse_otp_response(response)
            if (status == "ok" or status == "cancelled") and otp:
                return otp
        except Exception as e:
            print(f"Error polling OTP: {e}")
            
        if time.time() >= deadline:
            return None
        time.sleep(poll_interval)

def parse_otp_response(text: str) -> Tuple[str, Optional[str]]:
    if text.startswith("STATUS_OK:"):
        otp = extract_otp(text)
        return "ok", otp
    if text.startswith("STATUS_CANCEL"):
        return "cancelled", None
    if text.startswith("ACCESS_WAITING"):
        return "waiting", None
    return "unknown", extract_otp(text)

def extract_otp(text: str) -> Optional[str]:
    matches = re.findall(r"\b(\d{4,8})\b", text)
    if not matches:
        return None
    return matches[-1]

# -------------------------------------------------------------
# File Database I/O Helpers
# -------------------------------------------------------------
def save_successful_account(phone_number: str, password: str, sms_code: str, jwt_token: str = "PLAYWRIGHT_SUCCESS"):
    file_path = os.path.join(os.path.dirname(__file__), "accounts.json")
    accounts = []
    try:
        if os.path.exists(file_path):
            with open(file_path, "r", encoding="utf-8") as f:
                accounts = json.load(f)
    except Exception as e:
        print(f"Error reading accounts.json: {e}")
        
    accounts.append({
        "phoneNumber": phone_number,
        "password": password,
        "smsCode": sms_code,
        "jwtToken": jwt_token,
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
    })
    
    try:
        with open(file_path, "w", encoding="utf-8") as f:
            json.dump(accounts, f, indent=2)
        print(f"Account {phone_number} successfully saved to database.")
    except Exception as e:
        print(f"Error writing to accounts.json: {e}")

def save_failed_registration(phone_number: str, password: str, sms_code: str, error_message: str):
    file_path = os.path.join(os.path.dirname(__file__), "failed_registrations.json")
    failures = []
    try:
        if os.path.exists(file_path):
            with open(file_path, "r", encoding="utf-8") as f:
                failures = json.load(f)
    except Exception as e:
        print(f"Error reading failed_registrations.json: {e}")
        
    failures.append({
        "phoneNumber": phone_number,
        "password": password,
        "smsCode": sms_code,
        "error": error_message,
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
    })
    
    try:
        with open(file_path, "w", encoding="utf-8") as f:
            json.dump(failures, f, indent=2)
        print(f"Logged registration failure details for number {phone_number} with OTP {sms_code} to database.")
    except Exception as e:
        print(f"Error writing to failed_registrations.json: {e}")

# -------------------------------------------------------------
# Main Registration Flow (Playwright)
# -------------------------------------------------------------
def run_registration():
    config = load_config()
    invite_code = config.get("INVITE_CODE", "TDPARP")
    password = config.get("PASSWORD", "Zazbhai8709#")
    
    phone_number = None
    sms_code = None
    request_id = None
    
    print("Requesting virtual number...")
    number_info = get_number(config)
    if not number_info:
        print("Error: Failed to fetch virtual number from SMS API.")
        sys.exit(1)
        
    request_id, phone_number = number_info
    print(f"Obtained Number: {phone_number} (Request ID: {request_id})")

    # 2. Setup proxy selection
    proxy_settings = None
    proxy_val = config.get("PROXY", "").strip()
    selected_proxy = ""
    
    if proxy_val:
        # Support list of proxies separated by newlines
        proxies = [p.strip() for p in proxy_val.split("\n") if p.strip()]
        if proxies:
            selected_proxy = proxies[0]
            print(f"Configuring browser proxy: {selected_proxy}")
            server_url = selected_proxy
            username = None
            password = None
            
            # Check for authentication credentials in the proxy URL
            if "@" in selected_proxy:
                try:
                    # e.g., http://user:pass@ip:port
                    schema_part = ""
                    if "://" in selected_proxy:
                        schema_part, rest = selected_proxy.split("://", 1)
                    else:
                        rest = selected_proxy
                    
                    auth_part, host_part = rest.split("@", 1)
                    user_part, pass_part = auth_part.split(":", 1)
                    
                    # Reconstruct clean server url without credentials
                    server_url = f"{schema_part}://{host_part}" if schema_part else host_part
                    username = user_part
                    password = pass_part
                except Exception as e:
                    print(f"Warning: Failed to parse authenticated proxy URL. Using raw proxy string. ({e})")
            
            proxy_settings = {"server": server_url}
            if username and password:
                proxy_settings["username"] = username
                proxy_settings["password"] = password

    # Helper function to rotate proxies in config.json
    def rotate_proxies():
        if not proxy_val:
            return
        try:
            proxies = [p.strip() for p in proxy_val.split("\n") if p.strip()]
            if len(proxies) <= 1:
                return # Nothing to rotate
            
            # Move first proxy to the end of the list
            rotated = proxies[1:] + [proxies[0]]
            new_proxy_str = "\n".join(rotated)
            
            # Update configuration
            config_path = os.path.join(os.path.dirname(__file__), "config.json")
            if os.path.exists(config_path):
                with open(config_path, "r", encoding="utf-8") as f:
                    cfg_data = json.load(f)
                
                cfg_data["PROXY"] = new_proxy_str
                
                with open(config_path, "w", encoding="utf-8") as f:
                    json.dump(cfg_data, f, indent=2)
                print("[SYSTEM] Proxy rotated successfully in configuration database.")
        except Exception as err:
            print(f"Error rotating proxy: {err}")

    with sync_playwright() as p:
        browser_args = {
            # VPS Optimized parameters
            "args": [
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
                "--disable-accelerated-2d-canvas",
                "--disable-gpu",
                "--no-first-run",
                "--no-zygote",
                "--single-process"
            ]
        }
        if proxy_settings:
            browser_args["proxy"] = proxy_settings
            
        # Run headless=True by default for headless VPS environments
        browser = p.chromium.launch(headless=True, **browser_args)
        
        # Configure context with standard screen sizes and block heavy resources (like images/fonts) to save VPS bandwidth
        context = browser.new_context(
            viewport={"width": 1280, "height": 800},
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
        )
        page = context.new_page()
        
        # Block images and stylesheets/media files if possible, and filter third-party scripts to speed up page loading
        def route_handler(route):
            url = route.request.url
            res_type = route.request.resource_type
            if res_type in ["image", "media", "font"]:
                route.abort()
            elif res_type == "script" and not any(domain in url for domain in ["rexproearn.com", "localhost", "127.0.0.1"]):
                route.abort()
            else:
                route.continue_()
        page.route("**/*", route_handler)

        try:
            # Step 1: Open the registration page
            # Derive registration host domain from target api base url
            target_host = "https://rch5.rexproearn.com"
            registration_url = f"{target_host}/reg/?code={invite_code}"
            print(f"Navigating to: {registration_url}")
            page.goto(registration_url, wait_until="domcontentloaded")

            # Step 2 & 3: Fill the mobile number input field directly (instant)
            mobile_selector = 'input[maxlength="10"][type="text"].uni-input-input'
            print(f"Filling mobile number directly: {phone_number}")
            page.wait_for_selector(mobile_selector, timeout=10000)
            page.fill(mobile_selector, phone_number)

            # Step 4 & 5: Target password fields directly and fill them instantly
            print("Filling password fields directly...")
            password_fields = page.locator('input[type="password"]')
            password_fields.first.wait_for(timeout=5000)
            password_fields.nth(0).fill(password)
            password_fields.nth(1).fill(password)

            # Step 6: Click "Get OTP" and wait for the sendSmsCode network response
            otp_btn_selector = 'text="Get OTP"'
            print("Clicking 'Get OTP' button...")
            try:
                with page.expect_response("**/sendSmsCode", timeout=10000) as response_info:
                    page.click(otp_btn_selector)
                response = response_info.value
                response_text = response.text()
                print(f"Target App SMS Response: {response_text}")
                
                if "exceeds the limit" in response_text or '"code":500' in response_text:
                    err_msg = "SMS sending limit exceeded"
                    try:
                        resp_json = json.loads(response_text)
                        err_msg = resp_json.get("msg", err_msg)
                    except Exception:
                        pass
                    raise ValueError(f"Target app error: {err_msg}")
            except Exception as net_err:
                if isinstance(net_err, ValueError):
                    raise net_err
                print(f"Warning: Network response check failed or timed out: {net_err}")

            # Step 7: Retrieve OTP code with a max wait limit from configuration
            otp_wait_time = float(config.get("OTP_WAIT_TIME", 30.0))
            poll_interval = float(config.get("OTP_POLL_INTERVAL", 1.0))
            print(f"Waiting for OTP code from SMS API (max {otp_wait_time} seconds wait, polling every {poll_interval}s)...")
            sms_code = get_otp(request_id, timeout_seconds=otp_wait_time, poll_interval=poll_interval, config=config)

            if not sms_code:
                print("Error: Timeout reached without receiving OTP. Cancelling number...")
                cancel_number(request_id, config)
                browser.close()
                sys.exit(1)

            print(f"OTP received successfully: {sms_code}")

            # Step 8: Fill the retrieved OTP code into the browser input field directly (instant)
            otp_input_selector = 'input[maxlength="6"][type="number"].uni-input-input'
            print("Filling OTP code into registration form directly...")
            page.wait_for_selector(otp_input_selector, timeout=10000)
            page.fill(otp_input_selector, sms_code)

            # Step 9: Click the "Register" button and wait for the register request response
            print("Clicking 'Register' button...")
            
            try:
                # Find the best visible selector sequentially (prevents CSS parsing errors)
                register_selector = 'uni-button:has-text("Register")'
                for selector in [
                    'uni-button:has-text("Register")',
                    'button:has-text("Register")',
                    'text="Register"',
                    'uni-button'
                ]:
                    try:
                        if page.locator(selector).first.is_visible():
                            register_selector = selector
                            break
                    except Exception:
                        continue
                
                print(f"Using register selector: {register_selector}")
                page.wait_for_selector(register_selector, timeout=10000)
                
                with page.expect_response("**/register", timeout=15000) as response_info:
                    page.click(register_selector)
                response = response_info.value
                response_text = response.text()
                print(f"Target App Register Response: {response_text}")
                
                resp_json = json.loads(response_text)
                code = resp_json.get("code")
                msg = resp_json.get("msg", "")
                jwt_token = resp_json.get("data")
                
                if msg == "success" or code == 200:
                    print("Registration successfully validated on target server.")
                    # Save successfully registered account database record with token
                    save_successful_account(phone_number, password, sms_code, jwt_token or "PLAYWRIGHT_SUCCESS")
                else:
                    err_msg = msg or f"Registration failed with code {code}"
                    raise ValueError(err_msg)
            except Exception as reg_err:
                err_msg = str(reg_err)
                if "Target app error" in err_msg:
                    err_msg = err_msg.replace("Target app error: ", "")
                raise ValueError(f"Registration API failure: {err_msg}")

            print("Form successfully submitted! Closing browser...")
            time.sleep(1)

        except Exception as e:
            print(f"Error during registration flow: {e}")
            if phone_number and sms_code:
                err_msg = str(e)
                if err_msg.startswith("Registration API failure: "):
                    err_msg = err_msg.replace("Registration API failure: ", "")
                save_failed_registration(phone_number, password, sms_code, err_msg)
            print("Cancelling number due to execution failure...")
            cancel_number(request_id, config)
            
            # Check if proxy rotation is required
            err_str = str(e).lower()
            if "exceeds the limit" in err_str or "sending limit exceeded" in err_str:
                print("[SYSTEM] SMS sending limit exceeded detected. Rotating proxy list...")
                rotate_proxies()
                
            sys.exit(1)
            
        finally:
            browser.close()

if __name__ == "__main__":
    run_registration()
